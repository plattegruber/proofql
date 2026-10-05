/**
 * The Hono app for the api worker — the composition root. Exported
 * separately from the wrangler entrypoint (src/worker.ts) so tests can build
 * one with `createApp({ db })` and drive it with `app.request()` under Node.
 *
 * Middleware order matters: request id and per-request logger first (every
 * response, including errors, carries the id; every log line carries it
 * too — src/request-id.ts), then lazy database access, then the rate limiters
 * (installed here, enforced by `requireApiKey` once the key is known), then
 * routes. The monthly query quota (src/quota.ts) is route-level on
 * `/v1/query`: the counting half is middleware after that route's auth, the
 * refusing half is called by the handler once the KV cache
 * (src/query/cache.ts) has missed, so a cached answer is served at quota.
 * The counts go through one `UsageBuffer` per app — per isolate in
 * production — that writes in batches on a client of its own
 * (src/usage-buffer.ts, #108).
 */

import type { EmbeddingProvider, Reranker } from "@proofql/ai";
import type { LogSink } from "@proofql/core";
import type { Db } from "@proofql/db";
import { Hono } from "hono";
import { AuthCache } from "./auth-cache.js";
import {
  authFailureThrottle,
  injectedAuthFailureLimiter,
} from "./auth-throttle.js";
import type { AppEnv } from "./bindings.js";
import {
  type DbProvider,
  dbMiddleware,
  hyperdriveProvider,
  injectedProvider,
} from "./db.js";
import {
  defaultEdgeCache,
  type EdgeCacheLike,
  type EdgeCaches,
  GENERATION_MEMO_MS,
  GenerationMemo,
  MissCounter,
} from "./edge-cache.js";
import {
  type EmbedderProvider,
  embedderMiddleware,
  injectedEmbedder,
  workersAiEmbedder,
} from "./embedder.js";
import { notFound, onError } from "./errors.js";
import { CACHE_TTL_SECONDS } from "./query/cache.js";
import { queryRoutes } from "./query/route.js";
import { recordUsage } from "./quota.js";
import {
  bindingProvider,
  injectedProvider as injectedRateLimiters,
  type PlanRateLimiters,
  type RateLimiter,
  type RateLimiterProvider,
  rateLimitMiddleware,
} from "./rate-limit.js";
import { requestGuards } from "./request-guards.js";
import { requestContext } from "./request-id.js";
import { reviewsRoutes } from "./routes/reviews.js";
import { reviewsCrudRoutes } from "./routes/reviews-crud.js";
import { securityHeaders } from "./security-headers.js";
import {
  USAGE_FLUSH_MS,
  UsageBuffer,
  type UsageWriter,
} from "./usage-buffer.js";

export interface CreateAppOptions {
  /** Tests: use this client instead of opening one from `env.HYPERDRIVE`. */
  db?: Db;
  /** Full control over how a request obtains its database. */
  dbProvider?: DbProvider;
  /** Tests: embed `q` with this (the deterministic fake) instead of `env.AI`. */
  embedder?: EmbeddingProvider;
  /** Full control over how a request obtains its embedder. */
  embedderProvider?: EmbedderProvider;
  /** Tests: rerank with this (e.g. `FakeReranker`) when `RERANK` is on. */
  reranker?: Reranker;
  /** Tests: use this limiter (one for both kinds, or one per kind). */
  rateLimiter?: RateLimiter | Partial<PlanRateLimiters>;
  /** Full control over how a request obtains its rate limiters. */
  rateLimiterProvider?: RateLimiterProvider;
  /** Tests: capture log lines (`recordingSink().sink`) instead of the console. */
  logSink?: LogSink;
  /** Tests: the per-IP auth-failure limiter (src/auth-throttle.ts). */
  authFailureLimiter?: RateLimiter;
  /**
   * How long the usage buffer accumulates before writing (ms). Defaults to
   * `USAGE_FLUSH_MS`, or 0 when `db` is injected — a test's `ctx.flush()`
   * must observe the counts without waiting.
   */
  usageFlushMs?: number;
  /** Full control over how the usage buffer writes (defaults to `recordUsage`). */
  usageWriter?: UsageWriter;
  /**
   * The Workers Cache API to use (src/edge-cache.ts). Defaults to
   * `caches.default` where it exists, or null — always null when `db` is
   * injected, unless given, so tests exercise the KV path by default.
   */
  edgeCache?: EdgeCacheLike | null;
  /** Share one resolved-key cache between apps (tests). */
  authCache?: AuthCache;
  /**
   * Generation memo lifetime (ms). Defaults to `GENERATION_MEMO_MS`, or 0
   * when `db` is injected — tests bump KV directly and expect the next
   * request to see it.
   */
  generationMemoMs?: number;
  /**
   * MISSes within the TTL before a result is written to KV (the write
   * budget, src/edge-cache.ts). Defaults to 2, or 1 when `db` is injected.
   */
  kvWriteAfterMisses?: number;
  /** Clock for the caches (tests). */
  now?: () => number;
}

/** The buffer `createApp` built, for tests that assert on flushes. */
export function usageBufferOf(app: Hono<AppEnv>): UsageBuffer {
  const buffer = usageBuffers.get(app);
  if (buffer === undefined) throw new Error("app was not built by createApp");
  return buffer;
}

const usageBuffers = new WeakMap<Hono<AppEnv>, UsageBuffer>();

export function createApp(options: CreateAppOptions = {}): Hono<AppEnv> {
  const provider =
    options.dbProvider ??
    (options.db ? injectedProvider(options.db) : hyperdriveProvider);

  const embedder =
    options.embedderProvider ??
    (options.embedder ? injectedEmbedder(options.embedder) : workersAiEmbedder);
  const rateLimiters =
    options.rateLimiterProvider ??
    (options.rateLimiter
      ? injectedRateLimiters(options.rateLimiter)
      : bindingProvider);

  // The flush opens its own client (the request's is closed by then):
  // through `provider`, so tests write into the injected db and production
  // opens one `API_DB_OPTIONS` client per flush.
  const usageWriter: UsageWriter =
    options.usageWriter ??
    (async (env, deltas) => {
      const handle = provider(env);
      try {
        await recordUsage(handle.db, deltas);
      } finally {
        await handle.close();
      }
    });
  const usage = new UsageBuffer({
    write: usageWriter,
    flushMs: options.usageFlushMs ?? (options.db ? 0 : USAGE_FLUSH_MS),
  });

  const injected = options.db !== undefined;
  const now = options.now ?? Date.now;
  const authCache = options.authCache ?? new AuthCache({ now });
  const edge: EdgeCaches = {
    cache:
      options.edgeCache !== undefined
        ? options.edgeCache
        : injected
          ? null
          : defaultEdgeCache(),
    missCounter: new MissCounter({
      threshold: options.kvWriteAfterMisses ?? (injected ? 1 : 2),
      windowMs: CACHE_TTL_SECONDS * 1000,
      now,
    }),
    generations: new GenerationMemo(
      options.generationMemoMs ?? (injected ? 0 : GENERATION_MEMO_MS),
      now,
    ),
  };

  const app = new Hono<AppEnv>();
  usageBuffers.set(app, usage);
  app.onError(onError);
  app.notFound(notFound);
  app.use(
    requestContext(
      options.logSink === undefined ? {} : { sink: options.logSink },
    ),
  );
  // Hardening (#49; docs/security.md), outermost in: headers on every
  // response, the per-IP auth-failure throttle (refuses boxed addresses
  // before any body or key is read), then the body guards (415/413).
  app.use(securityHeaders);
  app.use(
    authFailureThrottle(
      options.authFailureLimiter === undefined
        ? {}
        : { provider: injectedAuthFailureLimiter(options.authFailureLimiter) },
    ),
  );
  app.use(requestGuards);
  app.use(dbMiddleware(provider));
  app.use(
    embedderMiddleware(
      embedder,
      options.reranker ? () => options.reranker ?? null : undefined,
    ),
  );
  app.use(rateLimitMiddleware(rateLimiters));
  app.use(async (c, next) => {
    c.set("usage", usage);
    c.set("authCache", authCache);
    c.set("edge", edge);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/v1/reviews", reviewsRoutes);
  app.route("/v1/reviews", reviewsCrudRoutes);
  app.route("/v1/query", queryRoutes);

  return app;
}
