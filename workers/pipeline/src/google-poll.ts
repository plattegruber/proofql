/**
 * Google Business Profile review polling (#46; docs/google.md).
 *
 * One tick — the six-hourly cron, or a `connection.sync` queue message for
 * a single connection — walks every `connections` row with `kind = google`
 * and `status = active` and brings its reviews up to date:
 *
 * 1. Decrypt the credentials (`CREDENTIALS_KEY`, AES-GCM); refresh the
 *    access token when it expires within five minutes and store the new
 *    one. `invalid_grant` ⇒ `status = needs_reauth`, credentials cleared
 *    (dead tokens are never kept), `google.needs_reauth` logged, next
 *    connection.
 * 2. Open one `ingest_runs` row (`kind = google`, `environment = live`).
 * 3. For each mapped location that is **enabled and verified**: list
 *    reviews newest-first (`orderBy=updateTime desc`, pages of 50) until a
 *    review's `updateTime` is at or before the location's cursor or the
 *    pages run out; adapt (star-only and malformed reviews are counted as
 *    skipped); `upsertReviews` in batches of 100 with `onLimit:
 *    "truncate"` (reviews refused by the plan cap count as `failed` and
 *    log `google.cap_reached`); enqueue the index messages after each
 *    batch commits; then advance that location's cursor to the newest
 *    `updateTime` seen and persist it at once, so a tick cut short never
 *    re-walks a finished location.
 * 4. Close the run with the counts, stamp `last_synced_at`, clear
 *    `metadata.initial_sync_pending`. On a connection's **first** successful
 *    sync (`last_synced_at` was null, or the pending flag was set) the same
 *    transaction deletes the project's Places bootstrap rows — `source =
 *    google` with an `external_id` under `places/` (#115) — because the
 *    connector now holds those reviews under their Business Profile ids;
 *    `projects.review_count` is lowered by the same number and the
 *    project's cache generation is bumped so stale results drop out (#116).
 *
 * Pacing: one {@link Pacer} per tick (240 requests/minute, 80% of the
 * 300 QPM project quota every connection shares), awaited before every
 * data-API request. Connections with `initial_sync_pending` go first so
 * onboarding finishes in seconds; the rest follow in a deterministic
 * shuffle seeded by the tick hour, so no connection is always last.
 *
 * Failure shape: 429 stops the whole tick (the quota is shared — more
 * requests only dig deeper); the connection's run is closed `failed` with
 * a readable reason and everything resumes next tick from the persisted
 * cursors, with no duplicate rows because the upsert is keyed on the
 * review's resource name. 5xx retries once after `Retry-After` (or a
 * second), then fails that connection only. 401 forces one token refresh
 * and retry. Any other Google error on a location skips that location;
 * anything unexpected fails that connection's run and the tick moves on.
 * A wall-clock budget (default ten minutes) defers whatever is left to the
 * next tick.
 *
 * Credentials never reach the logs: only connection, project, location
 * and run ids are logged, and the logger redacts `plaintext` anyway.
 */

import {
  bumpProjectGeneration,
  type GenerationKv,
  type IngestMessage,
  type Logger,
} from "@proofql/core";
import { type Db, schema, upsertReviews } from "@proofql/db";
import {
  accessTokenExpiresWithin,
  adaptReview,
  CredentialsError,
  createGoogleClient,
  createPacer,
  decryptCredentials,
  encryptCredentials,
  expiryFrom,
  GoogleApiError,
  type GoogleClient,
  type GoogleCredentials,
  GoogleInvalidGrant,
  GoogleOAuthError,
  GoogleRateLimited,
  GoogleUnauthorized,
  GoogleUnavailable,
  importCredentialsKey,
  type MappedLocation,
  type Pacer,
  parseConnectionMetadata,
  parseLocationCursor,
  pollableLocations,
  refreshAccessToken,
  resolveGoogleEndpoints,
  serializeLocationCursor,
  stableOrder,
  v4LocationName,
} from "@proofql/google";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { chunked, type IngestQueue, QUEUE_SEND_BATCH_MAX } from "./sweep.js";

const { connections, ingestRuns, projects, reviews } = schema;

/** Places bootstrap rows (#115) carry their Places id under this prefix. */
export const PLACES_BOOTSTRAP_PREFIX = "places/";

/** Refresh the access token when it expires within this long. */
export const ACCESS_TOKEN_REFRESH_WITHIN_MS = 5 * 60_000;
/** `upsertReviews` batch size, same as the CSV import. */
export const UPSERT_BATCH_SIZE = 100;
/** Default wall-clock budget for one tick. */
export const DEFAULT_TICK_BUDGET_MS = 10 * 60_000;
/** Backoff before the single retry of a 5xx when Google sent no Retry-After. */
const UNAVAILABLE_RETRY_MS = 1_000;
const UNAVAILABLE_RETRY_MAX_MS = 5_000;

/** The env slice the poller reads (`PipelineBindings` fits). */
export interface GooglePollEnv {
  ENVIRONMENT: string;
  CREDENTIALS_KEY?: string | undefined;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  GOOGLE_OAUTH_BASE?: string | undefined;
  GOOGLE_TOKEN_URL?: string | undefined;
  GOOGLE_API_BASE?: string | undefined;
}

export interface GooglePollContext {
  db: Db;
  queue: IngestQueue;
  log: Logger;
  env: GooglePollEnv;
  /** The query cache's generation counter; bumped when bootstrap rows are superseded. */
  cache: GenerationKv;
  /** Injectable for tests (the fake server's `fetch`). Default: global fetch. */
  fetch?: typeof fetch;
  /** Injectable clock. */
  now?: () => Date;
  /** Injectable pacer (tests pass one with no sleep). */
  pacer?: Pacer;
  /** Injectable sleep for the 5xx retry. */
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
}

export interface GooglePollOptions {
  /** Only these connections (the `connection.sync` path); default: all active. */
  connectionIds?: readonly string[];
  trigger: "cron" | "queue";
}

export interface GooglePollResult {
  /** Active connections the tick considered. */
  connections: number;
  synced: number;
  needsReauth: number;
  failed: number;
  /** Connections not reached because the tick stopped (429 or budget). */
  deferred: number;
  rateLimited: boolean;
  /** Reviews Google handed us (newer than the cursor). */
  received: number;
  created: number;
  updated: number;
  skipped: number;
  /** Reviews refused by the plan cap. */
  rejected: number;
  /** Google data-API requests made. */
  requests: number;
  /** `not_configured` when the connector's secrets are absent; the tick did nothing. */
  skippedReason?: "not_configured";
}

type ConnectionRow = typeof connections.$inferSelect;

interface Counts {
  received: number;
  created: number;
  updated: number;
  skipped: number;
  rejected: number;
}

const zeroCounts = (): Counts => ({
  received: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  rejected: 0,
});

function add(into: Counts, from: Counts): void {
  into.received += from.received;
  into.created += from.created;
  into.updated += from.updated;
  into.skipped += from.skipped;
  into.rejected += from.rejected;
}

/** Thrown inside a sync to stop the whole tick (429). */
class StopTick extends Error {
  override readonly name = "StopTick";
  constructor(readonly cause429: GoogleRateLimited) {
    super(cause429.message);
  }
}

/** Thrown when the wall-clock budget runs out mid-connection. */
class BudgetExhausted extends Error {
  override readonly name = "BudgetExhausted";
}

function configured(env: GooglePollEnv): boolean {
  const set = (v: string | undefined) =>
    typeof v === "string" && v.trim().length > 0 && !v.startsWith("TBD-");
  return (
    set(env.CREDENTIALS_KEY) &&
    set(env.GOOGLE_CLIENT_ID) &&
    set(env.GOOGLE_CLIENT_SECRET)
  );
}

/** One tick. */
export async function pollGoogleConnections(
  ctx: GooglePollContext,
  options: GooglePollOptions,
): Promise<GooglePollResult> {
  const now = ctx.now ?? (() => new Date());
  const startedAt = now().getTime();
  const budgetMs = ctx.budgetMs ?? DEFAULT_TICK_BUDGET_MS;
  const log = ctx.log.child({ trigger: options.trigger, connector: "google" });
  const result: GooglePollResult = {
    connections: 0,
    synced: 0,
    needsReauth: 0,
    failed: 0,
    deferred: 0,
    rateLimited: false,
    received: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    rejected: 0,
    requests: 0,
  };

  if (!configured(ctx.env)) {
    log.log("google.poll.skipped", {
      level: "warn",
      reason: "not_configured",
      missing: (
        ["CREDENTIALS_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const
      ).filter((name) => !ctx.env[name] || ctx.env[name]?.startsWith("TBD-")),
    });
    return { ...result, skippedReason: "not_configured" };
  }

  const key = await importCredentialsKey(ctx.env.CREDENTIALS_KEY);
  const endpoints = resolveGoogleEndpoints(ctx.env);
  const client = createGoogleClient({ endpoints, fetch: ctx.fetch });
  const oauth = {
    endpoints,
    clientId: ctx.env.GOOGLE_CLIENT_ID as string,
    clientSecret: ctx.env.GOOGLE_CLIENT_SECRET as string,
    fetch: ctx.fetch,
  };
  const pacer = ctx.pacer ?? createPacer();
  const sleep =
    ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const rows = await ctx.db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.kind, "google"),
        eq(connections.status, "active"),
        options.connectionIds
          ? inArray(connections.id, [...options.connectionIds])
          : undefined,
      ),
    );
  const ordered = orderConnections(rows, now().toISOString().slice(0, 13));
  result.connections = ordered.length;
  log.log("google.tick.started", {
    connections: ordered.length,
    connection_ids: ordered.map((c) => c.id),
    initial_sync: ordered.filter(
      (c) => parseConnectionMetadata(c.metadata).initial_sync_pending === true,
    ).length,
  });

  const deps: SyncDeps = {
    ctx,
    key,
    client,
    oauth,
    pacer,
    sleep,
    now,
    deadline: startedAt + budgetMs,
  };

  for (let i = 0; i < ordered.length; i++) {
    const connection = ordered[i] as ConnectionRow;
    if (now().getTime() >= deps.deadline) {
      result.deferred = ordered.length - i;
      log.log("google.tick.budget_exhausted", {
        level: "warn",
        budget_ms: budgetMs,
        deferred: result.deferred,
      });
      break;
    }
    const outcome = await syncConnection(deps, connection, log);
    result.requests = client.requests;
    add(result, outcome.counts);
    if (outcome.status === "synced") result.synced += 1;
    else if (outcome.status === "needs_reauth") result.needsReauth += 1;
    else result.failed += 1;
    if (outcome.stopTick) {
      result.rateLimited = outcome.stopTick === "rate_limited";
      result.deferred = ordered.length - i - 1;
      break;
    }
  }

  log.log("google.tick.completed", {
    connections: result.connections,
    synced: result.synced,
    needs_reauth: result.needsReauth,
    failed: result.failed,
    deferred: result.deferred,
    rate_limited: result.rateLimited,
    received: result.received,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    rejected: result.rejected,
    requests: result.requests,
    paced_wait_ms: pacer.waitedMs,
    took_ms: now().getTime() - startedAt,
  });
  return result;
}

/** Pending initial syncs first (stable), then the rest in the tick's shuffle. */
export function orderConnections(
  rows: ConnectionRow[],
  seed: string,
): ConnectionRow[] {
  const pending = rows.filter(
    (c) => parseConnectionMetadata(c.metadata).initial_sync_pending === true,
  );
  const rest = rows.filter((c) => !pending.includes(c));
  return [...stableOrder(pending, seed), ...stableOrder(rest, seed)];
}

interface SyncDeps {
  ctx: GooglePollContext;
  key: CryptoKey;
  client: GoogleClient;
  oauth: Parameters<typeof refreshAccessToken>[0];
  pacer: Pacer;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  deadline: number;
}

interface SyncOutcome {
  status: "synced" | "needs_reauth" | "failed";
  counts: Counts;
  stopTick?: "rate_limited" | "budget";
}

async function syncConnection(
  deps: SyncDeps,
  connection: ConnectionRow,
  parent: Logger,
): Promise<SyncOutcome> {
  const { ctx, now } = deps;
  const log = parent.child({
    connection_id: connection.id,
    project_id: connection.projectId,
  });
  const counts = zeroCounts();
  const metadata = parseConnectionMetadata(connection.metadata);
  const locations = pollableLocations(metadata);
  const startedAt = now();

  // --- credentials ----------------------------------------------------------
  let credentials: GoogleCredentials;
  try {
    if (!connection.credentials) {
      throw new CredentialsError("no credentials stored", "bad_format");
    }
    credentials = await decryptCredentials(deps.key, connection.credentials);
  } catch (error) {
    const reason =
      error instanceof CredentialsError ? error.reason : "decrypt_failed";
    await markNeedsReauth(ctx.db, connection.id, now());
    log.log("google.needs_reauth", {
      level: "warn",
      reason: `credentials_${reason}`,
    });
    return { status: "needs_reauth", counts };
  }

  const refresh = async (): Promise<boolean> => {
    try {
      const issued = await refreshAccessToken(
        deps.oauth,
        credentials.refresh_token,
      );
      credentials = {
        ...credentials,
        access_token: issued.accessToken,
        expiry: expiryFrom(issued.expiresIn, now().getTime()),
      };
      await ctx.db
        .update(connections)
        .set({
          credentials: await encryptCredentials(deps.key, credentials),
          updatedAt: now(),
        })
        .where(eq(connections.id, connection.id));
      log.log("google.token_refreshed", { expiry: credentials.expiry });
      return true;
    } catch (error) {
      if (error instanceof GoogleInvalidGrant) {
        await markNeedsReauth(ctx.db, connection.id, now());
        log.log("google.needs_reauth", {
          level: "warn",
          reason: "invalid_grant",
        });
        return false;
      }
      throw error;
    }
  };

  if (
    accessTokenExpiresWithin(
      credentials,
      ACCESS_TOKEN_REFRESH_WITHIN_MS,
      now().getTime(),
    )
  ) {
    try {
      if (!(await refresh())) return { status: "needs_reauth", counts };
    } catch (error) {
      // A transient token-endpoint failure: not a reason to re-auth.
      log.log("google.sync.failed", {
        error,
        stage: "token_refresh",
        status: error instanceof GoogleOAuthError ? error.status : undefined,
      });
      return { status: "failed", counts };
    }
  }

  if (locations.length === 0) {
    await ctx.db
      .update(connections)
      .set({
        metadata: withoutPending(connection.metadata),
        updatedAt: now(),
      })
      .where(eq(connections.id, connection.id));
    log.log("google.sync.no_locations", {
      mapped: metadata.locations.length,
    });
    return { status: "synced", counts };
  }

  // --- the run ----------------------------------------------------------------
  const [run] = await ctx.db
    .insert(ingestRuns)
    .values({
      projectId: connection.projectId,
      environment: "live",
      kind: "google",
      status: "running",
      startedAt,
    })
    .returning({ id: ingestRuns.id });
  if (!run) throw new Error("ingest_runs insert returned no row");
  const runLog = log.child({ ingest_run_id: run.id });
  runLog.log("google.sync.started", {
    locations: locations.length,
    location_ids: locations.map((l) => l.id),
    initial_sync: metadata.initial_sync_pending === true,
  });

  const cursor = parseLocationCursor(connection.cursor);
  const locationErrors: string[] = [];
  let stopTick: SyncOutcome["stopTick"];
  let stopError: string | undefined;

  for (const location of locations) {
    try {
      const locationCounts = await syncLocation(
        deps,
        {
          connection,
          credentials: () => credentials,
          refresh,
          location,
          since: cursor[location.id],
          log: runLog.child({ location: location.id }),
          run: run.id,
        },
        (newest) => {
          cursor[location.id] = newest;
        },
      );
      add(counts, locationCounts);
      // Persist the cursor as soon as a location is complete.
      await ctx.db
        .update(connections)
        .set({ cursor: serializeLocationCursor(cursor), updatedAt: now() })
        .where(eq(connections.id, connection.id));
    } catch (error) {
      if (error instanceof StopTick) {
        stopTick = "rate_limited";
        stopError = `Google rate limit (429) while reading location ${location.id}; polling resumes next tick`;
        runLog.log("google.rate_limited", {
          level: "warn",
          location: location.id,
          retry_after_ms: error.cause429.retryAfterMs,
        });
        break;
      }
      if (error instanceof BudgetExhausted) {
        stopTick = "budget";
        stopError = `Tick time budget exhausted while reading location ${location.id}; polling resumes next tick`;
        break;
      }
      if (error instanceof GoogleApiError) {
        locationErrors.push(
          `location ${location.id}: ${error.googleStatus ?? "error"} (${error.status})`,
        );
        runLog.log("google.location.failed", {
          level: "warn",
          location: location.id,
          status: error.status,
          google_status: error.googleStatus,
        });
        continue;
      }
      // Anything else — a network failure, a token endpoint outage mid-walk,
      // a database error — fails this connection's run with the message and
      // lets the tick move on; the row must never be left `running`.
      locationErrors.push(
        `location ${location.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      runLog.log("google.sync.failed", {
        error,
        stage: "location",
        location: location.id,
      });
      break;
    }
  }

  const finishedAt = now();
  const failed = stopTick !== undefined || locationErrors.length > 0;
  const firstSync =
    connection.lastSyncedAt === null || metadata.initial_sync_pending === true;
  const error =
    stopError ?? (locationErrors.length > 0 ? locationErrors.join("; ") : null);
  await ctx.db
    .update(ingestRuns)
    .set({
      status: failed ? "failed" : "succeeded",
      received: counts.received,
      created: counts.created,
      updated: counts.updated,
      skipped: counts.skipped,
      failed: counts.rejected,
      error,
      finishedAt,
    })
    .where(eq(ingestRuns.id, run.id));

  let superseded = 0;
  if (!failed) {
    superseded = await ctx.db.transaction(async (tx) => {
      await tx
        .update(connections)
        .set({
          lastSyncedAt: finishedAt,
          metadata: withoutPending(connection.metadata),
          cursor: serializeLocationCursor(cursor),
          updatedAt: finishedAt,
        })
        .where(eq(connections.id, connection.id));
      if (!firstSync) return 0;
      return supersedePlacesBootstrap(tx, connection.projectId);
    });
    if (superseded > 0) {
      // After the commit, never inside it (packages/core cache-generation).
      const generation = await bumpProjectGeneration(
        ctx.cache,
        connection.projectId,
      );
      runLog.log("google.bootstrap_superseded", {
        deleted: superseded,
        generation,
      });
    }
  }

  runLog.log(failed ? "google.sync.failed" : "google.sync.completed", {
    ...(failed ? { level: "warn", error_message: error } : {}),
    locations: locations.length,
    received: counts.received,
    created: counts.created,
    updated: counts.updated,
    skipped: counts.skipped,
    rejected: counts.rejected,
    superseded,
    took_ms: finishedAt.getTime() - startedAt.getTime(),
  });

  const outcome: SyncOutcome = {
    status: failed ? "failed" : "synced",
    counts,
  };
  if (stopTick) outcome.stopTick = stopTick;
  return outcome;
}

interface LocationSync {
  connection: ConnectionRow;
  credentials: () => GoogleCredentials;
  /** Force a token refresh; false ⇒ the connection is now needs_reauth. */
  refresh: () => Promise<boolean>;
  location: MappedLocation;
  since: string | undefined;
  log: Logger;
  run: string;
}

/** Walk one location newest-first until the cursor; returns its counts. */
async function syncLocation(
  deps: SyncDeps,
  sync: LocationSync,
  onNewest: (newest: string) => void,
): Promise<Counts> {
  const { ctx, pacer, now } = deps;
  const { location, log } = sync;
  const counts = zeroCounts();
  const sinceMs = sync.since ? Date.parse(sync.since) : undefined;
  let newestMs = sinceMs ?? Number.NEGATIVE_INFINITY;
  let newest = sync.since;
  let pageToken: string | undefined;
  let pages = 0;
  let starOnly = 0;
  let invalid = 0;
  let done = false;

  while (!done) {
    if (now().getTime() >= deps.deadline) throw new BudgetExhausted();
    await pacer.acquire();
    const page = await listPage(deps, sync, pageToken);
    pages += 1;
    const raws = page.reviews ?? [];
    const fresh: Parameters<typeof upsertReviews>[1]["reviews"] = [];
    for (const raw of raws) {
      const outcome = adaptReview(raw, location);
      if (outcome.status === "invalid") {
        invalid += 1;
        counts.received += 1;
        log.log("google.review.invalid", {
          level: "warn",
          issues: outcome.issues,
        });
        continue;
      }
      const updatedMs = Date.parse(outcome.updateTime);
      if (sinceMs !== undefined && updatedMs <= sinceMs) {
        // Newest-first: everything from here on was seen last time.
        done = true;
        break;
      }
      counts.received += 1;
      if (updatedMs > newestMs) {
        newestMs = updatedMs;
        newest = outcome.updateTime;
      }
      if (outcome.status === "star_only") starOnly += 1;
      else fresh.push(outcome.review);
    }

    for (const batch of chunked(fresh, UPSERT_BATCH_SIZE)) {
      const result = await upsertReviews(ctx.db, {
        projectId: sync.connection.projectId,
        environment: "live",
        reviews: batch,
        onLimit: "truncate",
      });
      counts.created += result.created;
      counts.updated += result.updated;
      counts.skipped += result.skipped;
      counts.rejected += result.rejected.length;
      if (result.rejected.length > 0) {
        log.log("google.cap_reached", {
          level: "warn",
          rejected: result.rejected.length,
          limit: result.limit,
          review_count: result.reviewCount,
        });
      }
      for (const messages of chunked(result.toEnqueue, QUEUE_SEND_BATCH_MAX)) {
        await ctx.queue.sendBatch(
          messages.map((body) => ({ body: body as IngestMessage })),
        );
      }
    }

    if (!page.nextPageToken) done = true;
    pageToken = page.nextPageToken;
  }

  counts.skipped += starOnly + invalid;
  if (newest !== undefined && newest !== sync.since) onNewest(newest);
  log.log("google.sync.location", {
    pages,
    received: counts.received,
    created: counts.created,
    updated: counts.updated,
    star_only: starOnly,
    invalid,
    rejected: counts.rejected,
    cursor_before: sync.since ?? null,
    cursor_after: newest ?? null,
  });
  return counts;
}

/** One paged request with the connector's retry rules (module doc). */
async function listPage(
  deps: SyncDeps,
  sync: LocationSync,
  pageToken: string | undefined,
): Promise<Awaited<ReturnType<GoogleClient["listReviewsPage"]>>> {
  const name = v4LocationName(sync.location);
  const attempt = () =>
    deps.client.listReviewsPage(
      sync.credentials().access_token,
      name,
      pageToken,
    );
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof GoogleRateLimited) throw new StopTick(error);
    if (error instanceof GoogleUnavailable) {
      const wait = Math.min(
        error.retryAfterMs ?? UNAVAILABLE_RETRY_MS,
        UNAVAILABLE_RETRY_MAX_MS,
      );
      sync.log.log("google.request_retry", {
        level: "warn",
        status: error.status,
        wait_ms: wait,
      });
      await deps.sleep(wait);
      await deps.pacer.acquire();
      try {
        return await attempt();
      } catch (again) {
        if (again instanceof GoogleRateLimited) throw new StopTick(again);
        throw again;
      }
    }
    if (error instanceof GoogleUnauthorized) {
      sync.log.log("google.request_retry", {
        level: "warn",
        status: 401,
        wait_ms: 0,
      });
      if (!(await sync.refresh())) throw error;
      await deps.pacer.acquire();
      return attempt();
    }
    throw error;
  }
}

/**
 * Delete the project's Places bootstrap rows (#115) once the connector
 * holds the real thing, and lower `review_count` to match (floored at 0,
 * as the api's DELETE does). Chunks cascade. Returns the number deleted.
 */
export async function supersedePlacesBootstrap(
  db: Pick<Db, "delete" | "update">,
  projectId: string,
): Promise<number> {
  const deleted = await db
    .delete(reviews)
    .where(
      and(
        eq(reviews.projectId, projectId),
        eq(reviews.source, "google"),
        like(reviews.externalId, `${PLACES_BOOTSTRAP_PREFIX}%`),
      ),
    )
    .returning({ id: reviews.id });
  if (deleted.length > 0) {
    await db
      .update(projects)
      .set({
        reviewCount: sql`GREATEST(${projects.reviewCount} - ${deleted.length}, 0)`,
      })
      .where(eq(projects.id, projectId));
  }
  return deleted.length;
}

async function markNeedsReauth(
  db: Db,
  connectionId: string,
  now: Date,
): Promise<void> {
  await db
    .update(connections)
    .set({ status: "needs_reauth", credentials: null, updatedAt: now })
    .where(eq(connections.id, connectionId));
}

/** The metadata with `initial_sync_pending` removed. */
function withoutPending(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const { initial_sync_pending: _drop, ...rest } = metadata;
  return rest;
}
