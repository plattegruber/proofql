/**
 * Batched `usage` counters (#108). Until now every answered `/v1/query`
 * upserted its own `usage` row after the response — one transaction per
 * request on a connection the request had already opened. With the auth
 * cache (src/auth-cache.ts) a cache HIT no longer opens a connection for
 * anything else, so the usage write had to stop needing one too.
 *
 * ## How
 *
 * `record()` adds the request to an in-memory `(project, month)` delta —
 * module state lives as long as the isolate — and, if no flush is pending,
 * schedules one through `waitUntil`: sleep `flushMs`, then write every
 * accumulated delta in **one** statement over **one** short-lived client
 * (`recordUsage`, src/quota.ts: `INSERT … ON CONFLICT DO UPDATE SET queries
 * = usage.queries + excluded.queries`, still an atomic increment, never a
 * read-modify-write). Under load an isolate therefore opens one connection
 * per `flushMs` instead of one per request; idle, it opens none.
 *
 * ## What it costs
 *
 * - Counts lag by up to `flushMs` (5 s). The quota check reads `usage`
 *   from Postgres on a cache miss, so a project can overshoot its monthly
 *   limit by the requests in flight plus one flush window per isolate —
 *   quota.ts already documents the limit as a plan ceiling, not a billing
 *   invariant, and the dashboard's usage panel is a monthly total.
 * - An isolate torn down before its pending flush runs loses that window's
 *   counts. `waitUntil` keeps the isolate alive for the scheduled work, so
 *   this takes an eviction mid-sleep; the loss is bounded by one window.
 * - A flush whose write fails logs `usage.flush_failed` with the lost totals
 *   and drops them: retrying into a database that just refused a connection
 *   would make the storm worse, and counts are the one thing here that may
 *   be approximate.
 *
 * Tests get `flushMs: 0` (`createApp` picks it whenever a db is injected) so
 * `await ctx.flush()` observes the write, and a fresh buffer per app so
 * files do not share counts.
 */

import type { Logger } from "@proofql/core";
import type { Context } from "hono";

import type { ApiBindings, AppEnv } from "./bindings.js";
import { waitUntil } from "./db.js";

/** How long an isolate accumulates before writing (module doc). */
export const USAGE_FLUSH_MS = 5_000;

export interface UsageDelta {
  projectId: string;
  /** `YYYY-MM-01`, the `usage.month` key. */
  month: string;
  queries: number;
  cacheHits: number;
}

/** Writes one batch of deltas; given the bindings so it can open a client. */
export type UsageWriter = (
  env: ApiBindings,
  deltas: UsageDelta[],
) => Promise<void>;

export interface UsageBufferOptions {
  write: UsageWriter;
  /** Default `USAGE_FLUSH_MS`; 0 flushes on the next tick. */
  flushMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class UsageBuffer {
  readonly #write: UsageWriter;
  readonly #flushMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pending = new Map<string, UsageDelta>();
  #scheduled = false;
  /** Flushes attempted so far; tests count connections with it. */
  flushes = 0;

  constructor(options: UsageBufferOptions) {
    this.#write = options.write;
    this.#flushMs = options.flushMs ?? USAGE_FLUSH_MS;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Deltas not yet written, for tests and the failure log. */
  get pending(): readonly UsageDelta[] {
    return [...this.#pending.values()];
  }

  /**
   * Count one answered query for `projectId` this `month`; a `cacheHit` is
   * counted under `cache_hits` too. Schedules the flush if none is pending.
   */
  record(
    c: Context<AppEnv>,
    projectId: string,
    month: string,
    cacheHit: boolean,
  ): void {
    const id = `${projectId}:${month}`;
    const delta = this.#pending.get(id) ?? {
      projectId,
      month,
      queries: 0,
      cacheHits: 0,
    };
    delta.queries += 1;
    if (cacheHit) delta.cacheHits += 1;
    this.#pending.set(id, delta);

    if (!this.#scheduled) {
      this.#scheduled = true;
      waitUntil(c, this.#flushLater(c.env, c.get("log")));
    }
  }

  async #flushLater(env: ApiBindings, log: Logger): Promise<void> {
    await this.#sleep(this.#flushMs);
    await this.flush(env, log);
  }

  /** Write everything accumulated so far; safe to call with nothing pending. */
  async flush(env: ApiBindings, log: Logger): Promise<void> {
    const deltas = [...this.#pending.values()];
    this.#pending.clear();
    this.#scheduled = false;
    if (deltas.length === 0) return;
    this.flushes += 1;
    try {
      await this.#write(env, deltas);
    } catch (error) {
      // docs/observability.md `usage.flush_failed`: what was lost, and why.
      log.log("usage.flush_failed", {
        level: "error",
        projects: deltas.length,
        queries: deltas.reduce((n, d) => n + d.queries, 0),
        cache_hits: deltas.reduce((n, d) => n + d.cacheHits, 0),
        error,
      });
    }
  }
}
