/**
 * Server side of the pre-launch waitlist (docs/launch.md "Go").
 *
 * - `addToWaitlist` inserts the normalized address with `ON CONFLICT DO
 *   NOTHING` and reports whether a row was created. A repeat submission is
 *   a success from the user's side either way — the page never reveals
 *   whether an address was already on the list.
 * - `FixedWindowLimiter` counts submissions per client address in the
 *   `CACHE` KV namespace (`waitlist:ip:<sha256>`, one JSON counter per
 *   window), falling back to an isolate-local Map when the binding is
 *   absent (unit tests, `wrangler dev` without KV). KV is eventually
 *   consistent and the fallback is per isolate, so the count is
 *   approximate — abuse protection, not accounting, the same stance as the
 *   api's limiters (workers/api/src/rate-limit.ts). Addresses are hashed
 *   before they become keys; the raw ip is never stored or logged.
 * - `handleWaitlistSubmission` is the whole action: parse → honeypot →
 *   throttle → insert, returning `data()` the route hands back unchanged.
 *   Dependencies are injectable so the unit test drives it without
 *   Postgres or KV; the integration test covers the insert.
 */
import type { Logger } from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { data } from "react-router";

import { getCloudflare } from "./context";
import { type WithDb, withRequestDb } from "./db.server";
import { type FieldErrors, parseForm } from "./forms.server";
import {
  WAITLIST_HONEYPOT_FIELD,
  WAITLIST_RATE_LIMIT,
  WAITLIST_THROTTLED_MESSAGE,
  waitlistFormSchema,
} from "./waitlist";

// --- The insert --------------------------------------------------------------

export interface AddToWaitlistInput {
  /** Already normalized by `waitlistFormSchema` (trimmed, lowercased). */
  email: string;
  /** Which surface collected it; defaults to the table's `sign-up`. */
  source?: string;
}

export interface AddToWaitlistResult {
  /** False when the address was already on the list. */
  created: boolean;
}

export async function addToWaitlist(
  db: Db,
  input: AddToWaitlistInput,
): Promise<AddToWaitlistResult> {
  const rows = await db
    .insert(schema.waitlist)
    .values({
      email: input.email,
      ...(input.source === undefined ? {} : { source: input.source }),
    })
    .onConflictDoNothing({ target: schema.waitlist.email })
    .returning({ id: schema.waitlist.id });
  return { created: rows.length > 0 };
}

// --- The limiter -------------------------------------------------------------

export interface WaitlistLimiter {
  /** Count one attempt for `key`; `success: false` means refuse it. */
  limit(key: string): Promise<{ success: boolean }>;
}

/** The slice of a KV namespace the limiter uses; `MemoryKv` fits too. */
export interface CounterKv {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

interface Counter {
  count: number;
  /** Epoch ms when this window ends; a counter past it is treated as absent. */
  resetAt: number;
}

export const WAITLIST_LIMIT_PREFIX = "waitlist:ip:";
/** KV refuses `expirationTtl` under 60 s. */
const KV_MIN_TTL_S = 60;

/**
 * Fixed window per key: the first attempt opens a window of `period`
 * seconds, every attempt increments, the (limit+1)th is refused until the
 * window ends. The window's end rides inside the value so a store that
 * ignores TTLs (the memory fallback) expires it the same way.
 */
export class FixedWindowLimiter implements WaitlistLimiter {
  readonly #kv: CounterKv;
  readonly #config: { limit: number; period: number };
  readonly #now: () => number;

  constructor(
    kv: CounterKv,
    config: { limit: number; period: number } = WAITLIST_RATE_LIMIT,
    now: () => number = Date.now,
  ) {
    this.#kv = kv;
    this.#config = config;
    this.#now = now;
  }

  async limit(key: string): Promise<{ success: boolean }> {
    const now = this.#now();
    const current = parseCounter(await this.#kv.get(key), now);
    const counter: Counter = current ?? {
      count: 0,
      resetAt: now + this.#config.period * 1000,
    };
    if (counter.count >= this.#config.limit) return { success: false };
    counter.count += 1;
    const ttl = Math.max(
      KV_MIN_TTL_S,
      Math.ceil((counter.resetAt - now) / 1000),
    );
    await this.#kv.put(key, JSON.stringify(counter), { expirationTtl: ttl });
    return { success: true };
  }
}

function parseCounter(raw: string | null, now: number): Counter | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Counter>;
    if (
      typeof parsed.count !== "number" ||
      typeof parsed.resetAt !== "number" ||
      parsed.resetAt <= now
    ) {
      return null;
    }
    return { count: parsed.count, resetAt: parsed.resetAt };
  } catch {
    return null;
  }
}

/** Isolate-local store for when the `CACHE` binding is absent. */
class MemoryCounterKv implements CounterKv {
  readonly #store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.#store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    // Bounded: the counters carry their own expiry, so a sweep on growth is
    // enough to keep a long-lived isolate from accumulating keys.
    if (this.#store.size >= 10_000) this.#store.clear();
    this.#store.set(key, value);
  }
}

const memoryLimiter = new FixedWindowLimiter(new MemoryCounterKv());

export type WaitlistEnv = Partial<Pick<Env, "CACHE">>;

/** The KV-backed limiter when `CACHE` is bound, else the memory fallback. */
export function waitlistLimiterFor(env: WaitlistEnv): WaitlistLimiter {
  return env.CACHE ? new FixedWindowLimiter(env.CACHE) : memoryLimiter;
}

/** Cloudflare sets this on every request; absent means "not behind Cloudflare". */
export const CLIENT_IP_HEADER = "cf-connecting-ip";

/** `waitlist:ip:<sha256 hex of the address>` — the address itself never becomes a key. */
export async function limiterKeyFor(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ip),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${WAITLIST_LIMIT_PREFIX}${hex}`;
}

// --- The action --------------------------------------------------------------

export type WaitlistActionData =
  | { ok: true }
  | { ok: false; fieldErrors: FieldErrors };

export interface WaitlistSubmissionDeps {
  withDb: WithDb;
  limiterFor: (env: WaitlistEnv) => WaitlistLimiter;
}

const defaultDeps: WaitlistSubmissionDeps = {
  withDb: withRequestDb,
  limiterFor: waitlistLimiterFor,
};

export interface WaitlistSubmissionArgs {
  request: Request;
  context: Parameters<typeof getCloudflare>[0];
}

/**
 * Handle a POST to /sign-up while signup is closed. Returns the `data()`
 * the route returns as is: 200 `{ ok: true }` (also for a repeat address
 * and for a honeypot hit), 422 with field errors, 429 with a form-level
 * error when the address is over its window.
 */
export async function handleWaitlistSubmission(
  args: WaitlistSubmissionArgs,
  deps: WaitlistSubmissionDeps = defaultDeps,
) {
  const { env, log } = getCloudflare(args.context);
  const parsed = await parseForm(waitlistFormSchema, args.request);
  if (!parsed.ok) {
    return data<WaitlistActionData>(
      { ok: false, fieldErrors: parsed.fieldErrors },
      { status: 422 },
    );
  }

  // A filled honeypot is a bot: say yes, store nothing.
  if ((parsed.data[WAITLIST_HONEYPOT_FIELD] ?? "").trim() !== "") {
    log.log("waitlist.rejected", { level: "warn", reason: "honeypot" });
    return data<WaitlistActionData>({ ok: true });
  }

  const ip = args.request.headers.get(CLIENT_IP_HEADER);
  if (ip !== null) {
    const limiter = deps.limiterFor(env);
    const { success } = await limiter.limit(await limiterKeyFor(ip));
    if (!success) {
      logThrottled(log);
      return data<WaitlistActionData>(
        { ok: false, fieldErrors: { "": [WAITLIST_THROTTLED_MESSAGE] } },
        {
          status: 429,
          headers: { "Retry-After": String(WAITLIST_RATE_LIMIT.period) },
        },
      );
    }
  }

  const { created } = await deps.withDb(args.context, (db) =>
    addToWaitlist(db, { email: parsed.data.email }),
  );
  log.log("waitlist.joined", { created, source: "sign-up" });
  return data<WaitlistActionData>({ ok: true });
}

function logThrottled(log: Logger): void {
  log.log("waitlist.throttled", {
    level: "warn",
    limit: WAITLIST_RATE_LIMIT.limit,
    period: WAITLIST_RATE_LIMIT.period,
  });
}
