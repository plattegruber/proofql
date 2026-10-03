/**
 * Per-IP throttle on authentication failures (#49; docs/security.md
 * "Brute force and enumeration").
 *
 * Keys are looked up by SHA-256 hash with ~190 bits of entropy
 * (@proofql/core apiKeys.ts), so guessing one is not a realistic attack and
 * a constant-time compare has nothing to protect — there is no compare.
 * What a throttle buys is a ceiling on *enumeration cost*: an attacker who
 * sprays well-formed keys at `/v1/*` pays one digest and one indexed lookup
 * per guess on our side, and this middleware stops paying after
 * `AUTH_FAIL_CONFIG.limit` failures per period from one address.
 *
 * Mechanics, in order:
 *
 *   1. The client address is `cf-connecting-ip`, which Cloudflare sets on
 *      every request. Without it (unit tests, `app.request()` with no
 *      headers) the throttle is inert: there is nothing to key on, and a
 *      shared "unknown" bucket would let one test file throttle another.
 *   2. Only `/v1/*` and only methods that authenticate: the CORS preflight
 *      (`OPTIONS`) runs without a key and never counts, nor does `/health`.
 *   3. After the route ran, a 401 or 403 **with no resolved key**
 *      (`c.get("auth")` unset — the refusals `requireApiKey` throws) counts
 *      one failure against the address. A 403 from the CORS check or a
 *      429 from the per-key limiter has a key behind it and never counts:
 *      authenticated traffic is invisible to this throttle.
 *   4. The counting is the `RL_AUTH_FAIL` rate limiting binding
 *      (wrangler.jsonc, namespace 1005, 30 per 60 s) when bound, else the
 *      same in-memory sliding window the per-key limiter falls back to.
 *      When the binding refuses, this failure is answered with 429
 *      `rate_limited` and `Retry-After` instead of the 401/403 — the
 *      attacker learns nothing from the status, and the address is put in
 *      a per-isolate penalty box until the period boundary.
 *   5. A request from a boxed address is refused before auth (no digest,
 *      no database). The box is per isolate and best-effort — the binding
 *      is the authoritative count; the box only saves the lookup on the
 *      isolate that saw the overflow.
 *
 * What it does not do: a valid key from a boxed address is refused for the
 * rest of the period (at most 60 s). That is the point of a per-IP
 * throttle, and a legitimate client behind the same NAT as a misbehaving
 * one is the accepted trade-off — the limit is thirty *failures* a minute,
 * which no working integration produces. The WAF rate-limit rule in
 * docs/security.md is the coarser backstop in front of this one.
 */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { ApiBindings, AppEnv } from "./bindings.js";
import { ApiError, errorResponse } from "./errors.js";
import {
  cloudflareLimiter,
  MemoryRateLimiter,
  type RateLimitConfig,
  type RateLimiter,
  secondsToNextPeriod,
} from "./rate-limit.js";
import { logFor } from "./request-id.js";

/** Mirrors the `RL_AUTH_FAIL` entry in wrangler.jsonc (a unit test checks). */
export const AUTH_FAIL_CONFIG: RateLimitConfig = { limit: 30, period: 60 };
export const AUTH_FAIL_BINDING = "RL_AUTH_FAIL";
export const AUTH_FAIL_NAMESPACE_ID = "1005";

/** Cloudflare sets this on every request; absent means "not behind Cloudflare". */
export const CLIENT_IP_HEADER = "cf-connecting-ip";

export type AuthFailureLimiterProvider = (
  env: ApiBindings | undefined,
) => RateLimiter;

/** Isolate-wide fallback, created once so counts persist across requests. */
const memoryLimiter = new MemoryRateLimiter(AUTH_FAIL_CONFIG);

/** The binding when bound, else the in-memory window. */
export const bindingAuthFailureLimiter: AuthFailureLimiterProvider = (env) => {
  const binding = env?.RL_AUTH_FAIL;
  return binding ? cloudflareLimiter(binding) : memoryLimiter;
};

/** For tests: a scripted limiter. */
export function injectedAuthFailureLimiter(
  limiter: RateLimiter,
): AuthFailureLimiterProvider {
  return () => limiter;
}

/** Addresses refused before auth, with the epoch ms their box expires. */
const penaltyBox = new Map<string, number>();

/** Boxed addresses tracked before expired entries are swept. */
const PENALTY_BOX_SWEEP_AT = 10_000;

/** `/v1` and everything under it: the routes that authenticate. */
export function isAuthRoute(path: string): boolean {
  return path === "/v1" || path.startsWith("/v1/");
}

/** A refusal `requireApiKey` produced: 401/403 and no key was resolved. */
export function isAuthFailure(c: Context<AppEnv>): boolean {
  return (
    (c.res.status === 401 || c.res.status === 403) &&
    c.get("auth") === undefined
  );
}

export interface AuthFailureThrottleOptions {
  provider?: AuthFailureLimiterProvider;
  /** Injectable clock for the penalty box (tests). */
  now?: () => number;
}

/**
 * Mounted once in `createApp`, after the request context (it logs) and
 * before the routes (it reads the status they produce).
 */
export function authFailureThrottle(options: AuthFailureThrottleOptions = {}) {
  const provider = options.provider ?? bindingAuthFailureLimiter;
  const now = options.now ?? Date.now;
  return createMiddleware<AppEnv>(async (c, next) => {
    const ip = c.req.header(CLIENT_IP_HEADER);
    if (
      ip === undefined ||
      ip === "" ||
      !isAuthRoute(c.req.path) ||
      c.req.method === "OPTIONS"
    ) {
      await next();
      return;
    }

    const at = now();
    const boxedUntil = penaltyBox.get(ip);
    if (boxedUntil !== undefined) {
      if (boxedUntil > at) {
        return refuse(c, Math.max(1, Math.ceil((boxedUntil - at) / 1000)), {
          phase: "penalty_box",
        });
      }
      penaltyBox.delete(ip);
    }

    await next();
    if (!isAuthFailure(c)) return;

    const { success } = await provider(c.env).limit(ip);
    if (success) return;

    const retryAfter = secondsToNextPeriod(AUTH_FAIL_CONFIG.period, at);
    if (penaltyBox.size >= PENALTY_BOX_SWEEP_AT) sweep(at);
    penaltyBox.set(ip, at + retryAfter * 1000);
    c.res = refuse(c, retryAfter, { phase: "failure" });
  });
}

/**
 * The 429 for a throttled address. The address itself is not logged — the
 * logging rule is identifiers and measurements, never personal data, and
 * Cloudflare's own request logs carry it for an investigation.
 */
function refuse(
  c: Context<AppEnv>,
  retryAfter: number,
  fields: { phase: "failure" | "penalty_box" },
): Response {
  c.header("Retry-After", String(retryAfter));
  logFor(c).log("auth.throttled", {
    level: "warn",
    ...fields,
    limit: AUTH_FAIL_CONFIG.limit,
    period: AUTH_FAIL_CONFIG.period,
    retry_after: retryAfter,
  });
  return errorResponse(
    c,
    new ApiError(
      "rate_limited",
      `Too many failed authentication attempts from this address (${AUTH_FAIL_CONFIG.limit} per ${AUTH_FAIL_CONFIG.period} seconds). Check the key you are sending and retry after ${retryAfter} seconds.`,
    ),
  );
}

function sweep(at: number): void {
  for (const [ip, until] of penaltyBox) {
    if (until <= at) penaltyBox.delete(ip);
  }
}

/** Tests only: forget every boxed address. */
export function resetPenaltyBox(): void {
  penaltyBox.clear();
}
