/**
 * Per-key rate limiting (scope.md §3 "Rate limited per key"; issues #29, #54).
 *
 * Every authenticated `/v1/*` request is counted against its API key:
 * `requireApiKey` calls `enforceRateLimit(c)` right after it resolves the
 * key, so a route cannot forget to opt in and a rotated key starts fresh
 * (the counter is keyed on `api_keys.id`, not the project). Limits come from
 * the plan table (`PLANS[plan].rateLimits`, @proofql/core) and are per key
 * *kind* — publishable keys live in browsers and get the lower number:
 *
 *                 secret   publishable   (requests / 60 s)
 *   free            300           120
 *   paid          1,000           600
 *
 * The counting is done by Cloudflare's rate limiting bindings (`ratelimits`
 * in wrangler.jsonc), which are approximate and per colo — good enough for
 * abuse protection, and the only option with zero per-request storage cost.
 * A binding's limit is fixed in the config, so there is one binding per
 * (plan, kind) pair — `RL_SECRET` / `RL_PUBLISHABLE` for free,
 * `RL_SECRET_PAID` / `RL_PUBLISHABLE_PAID` for paid (`RATE_LIMIT_BINDINGS`)
 * — selected by the plan that arrived with the key (`auth.plan`). The
 * config must mirror the plan table; `rate-limit.test.ts` reads
 * wrangler.jsonc and fails when the two disagree, so a new plan tier is one
 * edit in PLANS plus the matching `ratelimits` entries. Behind the
 * `RateLimiter` interface so unit tests use a fake and a worker without the
 * bindings falls back to an in-memory sliding window per isolate (`wrangler
 * dev` without the config, Node tests), configured from the same table.
 *
 * A refused request gets 429 `rate_limited` with `Retry-After` (seconds to
 * the next period boundary — the binding does not expose a precise reset)
 * and the IETF draft `RateLimit-Policy` / `RateLimit-Limit` headers, which
 * every limited response carries so clients can pace themselves before
 * they hit the wall.
 */

import {
  type ApiKeyKind,
  normalizePlan,
  PLAN_NAMES,
  type Plan,
  planFor,
  RATE_LIMIT_PERIOD_SECONDS,
} from "@proofql/core";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { ApiBindings, AppEnv } from "./bindings.js";
import { ApiError } from "./errors.js";
import { logFor } from "./request-id.js";

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
/** One limiter per key kind — the set that applies to one plan. */
export type PlanRateLimiters = Record<ApiKeyKind, RateLimiter>;
/** Every plan's limiters; `enforceRateLimit` picks by `auth.plan`. */
export type RateLimiters = Record<Plan, PlanRateLimiters>;

export const KEY_KINDS: readonly ApiKeyKind[] = ["secret", "publishable"];

/** The plan table's number for one (plan, kind) pair, as a limiter config. */
export function rateLimitConfig(
  plan: string,
  kind: ApiKeyKind,
): RateLimitConfig {
  return {
    limit: planFor(plan).rateLimits[kind],
    period: RATE_LIMIT_PERIOD_SECONDS,
  };
}

/** Both kinds for a plan. */
export function rateLimitConfigs(plan: string): RateLimitConfigs {
  return {
    secret: rateLimitConfig(plan, "secret"),
    publishable: rateLimitConfig(plan, "publishable"),
  };
}

/** Binding names in `ApiBindings` that carry `RateLimit` bindings. */
export type RateLimitBindingName = {
  [K in keyof ApiBindings]-?: NonNullable<ApiBindings[K]> extends RateLimit
    ? K
    : never;
}[keyof ApiBindings];

/**
 * Which wrangler.jsonc `ratelimits` binding counts each (plan, kind). The
 * free pair keeps the original names (#29); later plans add a suffix.
 */
export const RATE_LIMIT_BINDINGS: Readonly<
  Record<Plan, Readonly<Record<ApiKeyKind, RateLimitBindingName>>>
> = {
  free: { secret: "RL_SECRET", publishable: "RL_PUBLISHABLE" },
  paid: { secret: "RL_SECRET_PAID", publishable: "RL_PUBLISHABLE_PAID" },
};

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

/** Isolate-wide fallbacks, created once per (plan, kind) so counts persist. */
const memoryLimiters = new Map<string, MemoryRateLimiter>();

function memoryLimiterFor(plan: Plan, kind: ApiKeyKind): MemoryRateLimiter {
  const id = `${plan}:${kind}`;
  let limiter = memoryLimiters.get(id);
  if (limiter === undefined) {
    limiter = new MemoryRateLimiter(rateLimitConfig(plan, kind));
    memoryLimiters.set(id, limiter);
  }
  return limiter;
}

/** Build a `RateLimiters` table from a per-(plan, kind) factory. */
function limitersFrom(
  pick: (plan: Plan, kind: ApiKeyKind) => RateLimiter,
): RateLimiters {
  const table = {} as RateLimiters;
  for (const plan of PLAN_NAMES) {
    table[plan] = {
      secret: pick(plan, "secret"),
      publishable: pick(plan, "publishable"),
    };
  }
  return table;
}

/**
 * The real thing: the plan's binding when bound, else the in-memory
 * fallback for that plan and kind. Bindings are resolved per pair, so a
 * config that binds only the free pair still enforces paid limits (in
 * memory) instead of counting paid keys against the free binding.
 */
export const bindingProvider: RateLimiterProvider = (env) =>
  limitersFrom((plan, kind) => {
    const binding = env?.[RATE_LIMIT_BINDINGS[plan][kind]];
    return binding ? cloudflareLimiter(binding) : memoryLimiterFor(plan, kind);
  });

/**
 * For tests: one fake for every plan and kind, or one per kind (applied to
 * every plan). The plan a request resolves to is still observable through
 * the advertised headers.
 */
export function injectedProvider(
  limiters: RateLimiter | Partial<PlanRateLimiters>,
): RateLimiterProvider {
  const perKind: PlanRateLimiters =
    "limit" in limiters && typeof limiters.limit === "function"
      ? { secret: limiters, publishable: limiters }
      : {
          secret: (limiters as Partial<PlanRateLimiters>).secret ?? allowAll,
          publishable:
            (limiters as Partial<PlanRateLimiters>).publishable ?? allowAll,
        };
  const table = limitersFrom((_plan, kind) => perKind[kind]);
  return () => table;
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
  const plan = normalizePlan(auth.plan);
  const config = rateLimitConfig(plan, auth.kind);
  // Advertised on every limited response, refused or not (IETF draft
  // ratelimit-headers), so a client can pace itself.
  c.header("RateLimit-Policy", `${config.limit};w=${config.period}`);
  c.header("RateLimit-Limit", String(config.limit));

  const limiter = c.get("getRateLimiters")()[plan][auth.kind];
  const { success } = await limiter.limit(auth.apiKeyId);
  if (success) return;

  const retryAfter = secondsToNextPeriod(config.period);
  c.header("Retry-After", String(retryAfter));
  // The refusal itself (docs/observability.md `ratelimit.rejected`): which
  // key, how hard the wall is. The 429 also produces a `*.rejected` line
  // from onError; this one carries the limiter's own numbers.
  logFor(c).log("ratelimit.rejected", {
    level: "warn",
    project_id: auth.projectId,
    key_environment: auth.environment,
    key_kind: auth.kind,
    api_key_id: auth.apiKeyId,
    limit: config.limit,
    period: config.period,
    retry_after: retryAfter,
  });
  throw new ApiError(
    "rate_limited",
    `Rate limit of ${config.limit} requests per ${config.period} seconds reached for this ${auth.kind} key (${plan} plan). Retry after ${retryAfter} seconds.`,
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
