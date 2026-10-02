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
 */

import type { EmbeddingProvider } from "@proofql/ai";
import type { LogSink } from "@proofql/core";
import type { Db } from "@proofql/db";
import { Hono } from "hono";

import type { AppEnv } from "./bindings.js";
import {
  type DbProvider,
  dbMiddleware,
  hyperdriveProvider,
  injectedProvider,
} from "./db.js";
import {
  type EmbedderProvider,
  embedderMiddleware,
  injectedEmbedder,
  workersAiEmbedder,
} from "./embedder.js";
import { notFound, onError } from "./errors.js";
import { queryRoutes } from "./query/route.js";
import {
  bindingProvider,
  injectedProvider as injectedRateLimiters,
  type PlanRateLimiters,
  type RateLimiter,
  type RateLimiterProvider,
  rateLimitMiddleware,
} from "./rate-limit.js";
import { requestContext } from "./request-id.js";
import { reviewsRoutes } from "./routes/reviews.js";
import { reviewsCrudRoutes } from "./routes/reviews-crud.js";

export interface CreateAppOptions {
  /** Tests: use this client instead of opening one from `env.HYPERDRIVE`. */
  db?: Db;
  /** Full control over how a request obtains its database. */
  dbProvider?: DbProvider;
  /** Tests: embed `q` with this (the deterministic fake) instead of `env.AI`. */
  embedder?: EmbeddingProvider;
  /** Full control over how a request obtains its embedder. */
  embedderProvider?: EmbedderProvider;
  /** Tests: use this limiter (one for both kinds, or one per kind). */
  rateLimiter?: RateLimiter | Partial<PlanRateLimiters>;
  /** Full control over how a request obtains its rate limiters. */
  rateLimiterProvider?: RateLimiterProvider;
  /** Tests: capture log lines (`recordingSink().sink`) instead of the console. */
  logSink?: LogSink;
}

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

  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.notFound(notFound);
  app.use(
    requestContext(
      options.logSink === undefined ? {} : { sink: options.logSink },
    ),
  );
  app.use(dbMiddleware(provider));
  app.use(embedderMiddleware(embedder));
  app.use(rateLimitMiddleware(rateLimiters));

  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/v1/reviews", reviewsRoutes);
  app.route("/v1/reviews", reviewsCrudRoutes);
  app.route("/v1/query", queryRoutes);

  return app;
}
