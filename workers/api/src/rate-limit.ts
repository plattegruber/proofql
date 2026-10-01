/**
 * Per-key rate limiting (scope.md §3 "Rate limited per key"; issue #29).
 *
 * Every authenticated `/v1/*` request is counted against its API key:
 * `requireApiKey` calls `enforceRateLimit(c)` right after it resolves the
 * key, so a route cannot forget to opt in and a rotated key starts fresh
 * (the counter is keyed on `api_keys.id`, not the project). Limits are per
 * key *kind* — publishable keys live in browsers and get the lower number:
 *
 *   secret       300 requests / 60 s
 *   publishable  120 requests / 60 s
 *
 * The counting is done by Cloudflare's rate limiting binding
 * (`RL_SECRET` / `RL_PUBLISHABLE`, `ratelimits` in wrangler.jsonc), which
 * is approximate and per colo — good enough for abuse protection, and the
 * only option with zero per-request storage cost. Behind the `RateLimiter`
 * interface so unit tests use a fake and a worker without the bindings
 * falls back to an in-memory sliding window per isolate (`wrangler dev`
 * without the config, Node tests).
 *
 * A refused request gets 429 `rate_limited` with `Retry-After` (seconds to
 * the next period boundary — the binding does not expose a precise reset)
 * and the IETF draft `RateLimit-Policy` / `RateLimit-Limit` headers, which
 * every limited response carries so clients can pace themselves before
 * they hit the wall.
 *
 * `RATE_LIMITS` (optional JSON var) overrides the numbers the worker
 * advertises and the in-memory limiter enforces; when the Cloudflare
 * bindings are present it must mirror their `simple` config, because the
 * binding's own limit is fixed in wrangler.jsonc. The hook is there so a
 * later plan tier can raise limits without a code change.
 */

import type { ApiKeyKind } from "@proofql/core";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { ApiBindings, AppEnv } from "./bindings.js";
import { ApiError } from "./errors.js";

export interface RateLimiter {
  /** Count one request for `key`; `success: false` means refuse it. */
  limit(key: string): Promise<{ success: boolean }>;
}

export interface RateLimitConfig {
  /** Requests allowed per `period`. */
  limit: number;
  /** Window length in seconds (the Cloudflare binding allows 10 or 60). */
  period: number;
}

export type RateLimitConfigs = Record<ApiKeyKind, RateLimitConfig>;
export type RateLimiters = Record<ApiKeyKind, RateLimiter>;

export const DEFAULT_RATE_LIMITS: RateLimitConfigs = {
  secret: { limit: 300, period: 60 },
  publishable: { limit: 120, period: 60 },
};

/**
 * Merge a `RATE_LIMITS` JSON override onto the defaults. Each kind is
 * optional and may set `limit` and/or `period`; anything that is not a
 * positive integer, or JSON that does not parse, is rejected loudly — a
 * silently ignored typo would advertise one limit and enforce another.
 */
export function parseRateLimits(json: string | undefined): RateLimitConfigs {
  if (json === undefined || json.trim() === "") return DEFAULT_RATE_LIMITS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error("RATE_LIMITS is not valid JSON", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("RATE_LIMITS must be a JSON object");

  const merged: RateLimitConfigs = {
    secret: { ...DEFAULT_RATE_LIMITS.secret },
    publishable: { ...DEFAULT_RATE_LIMITS.publishable },
  };
  for (const [kind, override] of Object.entries(parsed)) {
    if (kind !== "secret" && kind !== "publishable") {
      throw new Error(`RATE_LIMITS: unknown key kind "${kind}"`);
    }
    if (!isRecord(override)) {
      throw new Error(`RATE_LIMITS.${kind} must be an object`);
    }
    for (const field of ["limit", "period"] as const) {
      const value = override[field];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || (value as number) <= 0) {
        throw new Error(
          `RATE_LIMITS.${kind}.${field} must be a positive integer`,
        );
      }
      merged[kind][field] = value as number;
    }
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adapt a Cloudflare `RateLimit` binding to the interface. */
export function cloudflareLimiter(binding: RateLimit): RateLimiter {
  return { limit: (key) => binding.limit({ key }) };
}

/**
 * In-memory sliding window, for development and tests. State lives in the
 * instance (one per isolate in a worker), so it is neither shared across
 * isolates nor durable — fine for seeing the behavior locally, never for
 * production. `now` is injectable so window math is testable.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #config: RateLimitConfig;
  readonly #now: () => number;
  /** Request timestamps (ms) inside the current window, oldest first. */
  readonly #hits = new Map<string, number[]>();

  constructor(config: RateLimitConfig, now: () => number = Date.now) {
    this.#config = config;
    this.#now = now;
  }

  async limit(key: string): Promise<{ success: boolean }> {
    const now = this.#now();
    const windowStart = now - this.#config.period * 1000;
    let hits = this.#hits.get(key);
    if (hits === undefined) {
      if (this.#hits.size >= MEMORY_LIMITER_SWEEP_AT) this.#sweep(windowStart);
      hits = [];
      this.#hits.set(key, hits);
    }
    // Drop timestamps that have slid out of the window.
    let stale = 0;
    while (stale < hits.length && (hits[stale] as number) <= windowStart) {
      stale++;
    }
    if (stale > 0) hits.splice(0, stale);

    if (hits.length >= this.#config.limit) return { success: false };
    hits.push(now);
    return { success: true };
  }

  /** Forget keys with nothing left in the window, so idle keys free memory. */
  #sweep(windowStart: number): void {
    for (const [key, hits] of this.#hits) {
      const last = hits[hits.length - 1];
      if (last === undefined || last <= windowStart) this.#hits.delete(key);
    }
  }
}

/** Keys tracked before an idle-key sweep runs on the next new key. */
const MEMORY_LIMITER_SWEEP_AT = 10_000;

/**
 * How the app obtains this request's limiters. `env` is undefined when a
 * test drives the app with `app.request(path, init)` and no bindings, so
 * providers must cope with that (the fallback below does).
 */
export type RateLimiterProvider = (
  env: ApiBindings | undefined,
) => RateLimiters;

/** Isolate-wide fallbacks, created once per config so counts persist. */
const memoryLimiters = new Map<string, MemoryRateLimiter>();

function memoryLimiterFor(
  kind: ApiKeyKind,
  config: RateLimitConfig,
): MemoryRateLimiter {
  const id = `${kind}:${config.limit}/${config.period}`;
  let limiter = memoryLimiters.get(id);
  if (limiter === undefined) {
    limiter = new MemoryRateLimiter(config);
    memoryLimiters.set(id, limiter);
  }
  return limiter;
}

/** The real thing: the bindings when bound, else the in-memory fallback. */
export const bindingProvider: RateLimiterProvider = (env) => {
  const configs = parseRateLimits(env?.RATE_LIMITS);
  return {
    secret: env?.RL_SECRET
      ? cloudflareLimiter(env.RL_SECRET)
      : memoryLimiterFor("secret", configs.secret),
    publishable: env?.RL_PUBLISHABLE
      ? cloudflareLimiter(env.RL_PUBLISHABLE)
      : memoryLimiterFor("publishable", configs.publishable),
  };
};

/** For tests: one fake for both kinds, or one per kind. */
export function injectedProvider(
  limiters: RateLimiter | Partial<RateLimiters>,
): RateLimiterProvider {
  const perKind: RateLimiters =
    "limit" in limiters && typeof limiters.limit === "function"
      ? { secret: limiters, publishable: limiters }
      : {
          secret: (limiters as Partial<RateLimiters>).secret ?? allowAll,
          publishable:
            (limiters as Partial<RateLimiters>).publishable ?? allowAll,
        };
  return () => perKind;
}

const allowAll: RateLimiter = { limit: async () => ({ success: true }) };

/**
 * Installs `c.get("getRateLimiters")`; mounted once in `createApp`. Lazy,
 * like `getDb`: resolved on first use, so unauthenticated requests (and
 * `app.request()` with no env at all) never touch the bindings.
 */
export function rateLimitMiddleware(provider: RateLimiterProvider) {
  return createMiddleware<AppEnv>(async (c, next) => {
    let limiters: RateLimiters | undefined;
    c.set("getRateLimiters", () => {
      limiters ??= provider(c.env);
      return limiters;
    });
    await next();
  });
}

/** Whole seconds until the next period boundary (at least 1). */
export function secondsToNextPeriod(
  period: number,
  nowMs: number = Date.now(),
): number {
  const elapsed = Math.floor(nowMs / 1000) % period;
  return Math.max(1, period - elapsed);
}

/**
 * Count this request against its key and refuse it with 429 when over.
 * Needs `c.get("auth")`; `requireApiKey` calls it immediately after setting
 * that. Exported so a route with its own auth can call it too.
 */
export async function enforceRateLimit(c: Context<AppEnv>): Promise<void> {
  const auth = c.get("auth");
  // `c.env` is undefined under `app.request()` with no bindings (see
  // RateLimiterProvider); the type says otherwise, hence the cast.
  const env = c.env as ApiBindings | undefined;
  const config = parseRateLimits(env?.RATE_LIMITS)[auth.kind];
  // Advertised on every limited response, refused or not (IETF draft
  // ratelimit-headers), so a client can pace itself.
  c.header("RateLimit-Policy", `${config.limit};w=${config.period}`);
  c.header("RateLimit-Limit", String(config.limit));

  const limiter = c.get("getRateLimiters")()[auth.kind];
  const { success } = await limiter.limit(auth.apiKeyId);
  if (success) return;

  const retryAfter = secondsToNextPeriod(config.period);
  c.header("Retry-After", String(retryAfter));
  throw new ApiError(
    "rate_limited",
    `Rate limit of ${config.limit} requests per ${config.period} seconds reached for this ${auth.kind} key. Retry after ${retryAfter} seconds.`,
  );
}

/**
 * The same check as a middleware, for a route whose auth does not run
 * `enforceRateLimit` itself. Mount it after the auth middleware.
 */
export const rateLimit = createMiddleware<AppEnv>(async (c, next) => {
  await enforceRateLimit(c);
  await next();
});
