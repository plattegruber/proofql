/**
 * Places bootstrap refresh (#116; docs/places.md "Refresh").
 *
 * Google's Places API (New) hands the dashboard a place's five most
 * relevant public reviews at onboarding (#47). Its terms cap how long that
 * content may be stored at 30 days, and the owner's reading is that this
 * is a cache limit — so the rows are **refetched, never deleted**: once a
 * day (`30 3 * * *`) this cron re-fetches every bootstrapped place whose
 * latest `places` run is more than 25 days old, for projects that have not
 * since connected a Google Business Profile (the connector carries no
 * such limit and supersedes the bootstrap rows on its first sync, #115).
 *
 * One tick:
 *
 * 1. Nothing without `GOOGLE_PLACES_API_KEY` (`places.refresh.skipped`).
 * 2. Candidates: for every `(project, environment, place)` the most recent
 *    `ingest_runs` row of kind `places` (`artifact_key = places:<id>`);
 *    due when it finished more than {@link PLACES_REFRESH_AFTER_DAYS} ago
 *    — or, for a run that `failed`, more than
 *    {@link PLACES_REFRESH_RETRY_FAILED_AFTER_DAYS} ago, so a Google
 *    outage costs a day, not a month — and the project has no `active`
 *    google connection, and at least one bootstrap row for that place is
 *    still in the project (a customer who deleted them all has opted out;
 *    a re-import from the dashboard starts over). Oldest first, at most
 *    {@link PLACES_REFRESH_LIMIT} per tick.
 * 3. Per candidate: open a `places` run, fetch the place **bypassing the
 *    KV cache** (the point is freshness; the fresh copy is written through
 *    so a dashboard re-import that day costs nothing), map
 *    (`mapPlaceReviews`), `upsertReviews(onLimit: "truncate")` — the same
 *    rows by `(source, external_id)`, text changes re-index — then delete
 *    the bootstrap rows for that place whose `external_id` Google no
 *    longer returned (lowering `projects.review_count` to match), enqueue
 *    the index messages, close the run with the counts (deletions in the
 *    run's human note, the schema has no column for them), and bump the
 *    project's cache generation when anything changed.
 * 4. Google errors fail only that project's run (`places.refresh.failed`,
 *    `error` = the human description); a 429 stops the whole tick, since
 *    the key's quota is shared and more requests only dig deeper.
 *
 * Quota: one Place Details request per project per 25 days, i.e. about
 * 1.2 per project per month against the 1,000 free (docs/places.md).
 */

import {
  bumpProjectGeneration,
  type GenerationKv,
  type IngestMessage,
  type Logger,
} from "@proofql/core";
import { type Db, schema, upsertReviews } from "@proofql/db";
import {
  createPlacesClient,
  describePlacesError,
  kvPlacesCache,
  mapPlaceReviews,
  PLACES_BOOTSTRAP_PREFIX,
  type PlacesClient,
  PlacesError,
  type PlacesKv,
  placeIdFromArtifactKey,
} from "@proofql/google";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  like,
  notExists,
  sql,
} from "drizzle-orm";

import { chunked, type IngestQueue, QUEUE_SEND_BATCH_MAX } from "./sweep.js";

const { connections, ingestRuns, projects, reviews } = schema;

/** The cron expression in wrangler.jsonc (all three env blocks). */
export const PLACES_REFRESH_CRON = "30 3 * * *";
/** A succeeded (or still `running`) bootstrap is refreshed after this long. */
export const PLACES_REFRESH_AFTER_DAYS = 25;
/** A failed refresh is retried after this long rather than in 25 days. */
export const PLACES_REFRESH_RETRY_FAILED_AFTER_DAYS = 1;
/** Places refreshed per tick, oldest first; the rest wait for tomorrow. */
export const PLACES_REFRESH_LIMIT = 200;

const DAY_MS = 86_400_000;

/** The env slice the refresh reads (`PipelineBindings` fits). */
export interface PlacesRefreshEnv {
  ENVIRONMENT: string;
  GOOGLE_PLACES_API_KEY?: string | undefined;
  PLACES_API_BASE?: string | undefined;
}

/** `env.CACHE` is both the generation counter and the Places cache; so is `MemoryKv`. */
export type PlacesRefreshKv = GenerationKv & PlacesKv;

export interface PlacesRefreshContext {
  db: Db;
  queue: IngestQueue;
  log: Logger;
  env: PlacesRefreshEnv;
  kv: PlacesRefreshKv;
  /** Injectable for tests (the fake Places API's `fetch`). Default: global fetch. */
  fetch?: typeof fetch;
  /** Injectable clock. */
  now?: () => Date;
  /** Per-tick cap; default {@link PLACES_REFRESH_LIMIT}. */
  limit?: number;
}

export interface PlacesRefreshResult {
  /** Due `(project, environment, place)` triples the tick picked up. */
  candidates: number;
  refreshed: number;
  failed: number;
  /** Candidates not reached because a 429 stopped the tick. */
  deferred: number;
  rateLimited: boolean;
  /** Reviews Google returned, over every refreshed place. */
  received: number;
  created: number;
  updated: number;
  /** Rating-only reviews and in-batch duplicates. */
  skipped: number;
  /** Reviews refused by the plan cap. */
  rejected: number;
  /** Bootstrap rows removed because Google no longer returns them. */
  deleted: number;
  /** Index messages enqueued. */
  enqueued: number;
  /** Place Details requests sent to Google. */
  requests: number;
  /** `not_configured` when the key is absent; the tick did nothing. */
  skippedReason?: "not_configured";
}

// --- Pure parts (unit-tested) ------------------------------------------------

export interface RefreshWindow {
  /** A latest run that did not fail is due when it ran before this. */
  succeededBefore: Date;
  /** A latest run that failed is due when it ran before this. */
  failedBefore: Date;
  limit: number;
}

/** The candidate query's inputs for a tick at `now`. */
export function refreshWindow(
  now: Date,
  options: {
    afterDays?: number | undefined;
    retryFailedAfterDays?: number | undefined;
    limit?: number | undefined;
  } = {},
): RefreshWindow {
  const afterDays = options.afterDays ?? PLACES_REFRESH_AFTER_DAYS;
  const retryAfterDays =
    options.retryFailedAfterDays ?? PLACES_REFRESH_RETRY_FAILED_AFTER_DAYS;
  return {
    succeededBefore: new Date(now.getTime() - afterDays * DAY_MS),
    failedBefore: new Date(now.getTime() - retryAfterDays * DAY_MS),
    limit: Math.max(0, Math.floor(options.limit ?? PLACES_REFRESH_LIMIT)),
  };
}

export interface ReconcilePlan {
  /** Stored bootstrap rows Google still returns (by `external_id`). */
  keep: string[];
  /** Stored bootstrap rows Google no longer returns: delete these. */
  remove: string[];
  /** Returned review names with no stored row yet. */
  added: string[];
}

/**
 * Which stored bootstrap rows of a place to drop, given what Google
 * returned. Only `external_id`s under `places/` are ever considered; a
 * review Google still returns is kept even when it now maps to nothing
 * (rating-only), since "no longer returned" is the rule. Order is the
 * input order; duplicates collapse.
 */
export function planReconcile(
  storedExternalIds: readonly string[],
  returnedNames: readonly string[],
): ReconcilePlan {
  const returned = new Set(returnedNames);
  const stored = new Set(storedExternalIds);
  const keep: string[] = [];
  const remove: string[] = [];
  for (const id of stored) {
    if (!id.startsWith(PLACES_BOOTSTRAP_PREFIX)) continue;
    (returned.has(id) ? keep : remove).push(id);
  }
  const added = [...returned].filter((name) => !stored.has(name));
  return { keep, remove, added };
}

/** The run's human note (`ingest_runs.error`) for a succeeded refresh, or null. */
export function refreshNote(input: {
  deleted: number;
  rejected: number;
  limit: number;
}): string | null {
  const parts: string[] = [];
  if (input.deleted > 0) {
    parts.push(
      `${input.deleted} ${input.deleted === 1 ? "review" : "reviews"} Google no longer returns ${input.deleted === 1 ? "was" : "were"} removed.`,
    );
  }
  if (input.rejected > 0) {
    parts.push(
      `${input.rejected} ${input.rejected === 1 ? "review was" : "reviews were"} not imported: the project is at its review limit (${input.limit.toLocaleString("en-US")} on this plan).`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Whether a refresh changed what a query may return. */
export function refreshChanged(input: {
  created: number;
  deleted: number;
  enqueued: number;
}): boolean {
  return input.created > 0 || input.deleted > 0 || input.enqueued > 0;
}

// --- Candidates --------------------------------------------------------------

export interface RefreshCandidate {
  projectId: string;
  environment: (typeof schema.ENVIRONMENTS)[number];
  placeId: string;
  /** When the latest `places` run for the place finished (or started). */
  lastRunAt: Date;
  lastStatus: (typeof schema.INGEST_RUN_STATUSES)[number];
}

/**
 * Due `(project, environment, place)` triples, oldest first — see the
 * module doc for the rule. One query: the latest `places` run per triple
 * (`DISTINCT ON`), filtered by age, by the absence of an active google
 * connection, and by a surviving bootstrap row for the place.
 */
export async function selectRefreshCandidates(
  db: Db,
  window: RefreshWindow,
): Promise<RefreshCandidate[]> {
  if (window.limit === 0) return [];
  const latest = db.$with("latest_places_run").as(
    db
      .selectDistinctOn(
        [ingestRuns.projectId, ingestRuns.environment, ingestRuns.artifactKey],
        {
          projectId: ingestRuns.projectId,
          environment: ingestRuns.environment,
          artifactKey: ingestRuns.artifactKey,
          status: ingestRuns.status,
          ranAt:
            sql<Date>`coalesce(${ingestRuns.finishedAt}, ${ingestRuns.startedAt})`.as(
              "ran_at",
            ),
        },
      )
      .from(ingestRuns)
      .where(
        and(
          eq(ingestRuns.kind, "places"),
          like(ingestRuns.artifactKey, "places:%"),
        ),
      )
      .orderBy(
        ingestRuns.projectId,
        ingestRuns.environment,
        ingestRuns.artifactKey,
        desc(ingestRuns.startedAt),
      ),
  );
  const placeId = sql<string>`substr(${latest.artifactKey}, ${"places:".length + 1})`;
  const rows = await db
    .with(latest)
    .select({
      projectId: latest.projectId,
      environment: latest.environment,
      artifactKey: latest.artifactKey,
      status: latest.status,
      ranAt: latest.ranAt,
    })
    .from(latest)
    .where(
      and(
        sql`${latest.ranAt} < case when ${latest.status} = 'failed' then ${window.failedBefore.toISOString()}::timestamptz else ${window.succeededBefore.toISOString()}::timestamptz end`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(connections)
            .where(
              and(
                eq(connections.projectId, latest.projectId),
                eq(connections.kind, "google"),
                eq(connections.status, "active"),
              ),
            ),
        ),
        exists(
          db
            .select({ one: sql`1` })
            .from(reviews)
            .where(
              and(
                eq(reviews.projectId, latest.projectId),
                eq(reviews.environment, latest.environment),
                eq(reviews.source, "google"),
                like(reviews.externalId, `${PLACES_BOOTSTRAP_PREFIX}%`),
                sql`${reviews.metadata}->>'place_id' = ${placeId}`,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(latest.ranAt))
    .limit(window.limit);

  const candidates: RefreshCandidate[] = [];
  for (const row of rows) {
    const id = row.artifactKey ? placeIdFromArtifactKey(row.artifactKey) : null;
    if (!id) continue;
    candidates.push({
      projectId: row.projectId,
      environment: row.environment,
      placeId: id,
      lastRunAt: new Date(row.ranAt),
      lastStatus: row.status,
    });
  }
  return candidates;
}

// --- The tick ----------------------------------------------------------------

function configured(env: PlacesRefreshEnv): boolean {
  const key = env.GOOGLE_PLACES_API_KEY?.trim() ?? "";
  return key !== "" && !key.startsWith("TBD-");
}

/** One daily tick. */
export async function refreshPlacesBootstraps(
  ctx: PlacesRefreshContext,
): Promise<PlacesRefreshResult> {
  const now = ctx.now ?? (() => new Date());
  const startedAt = now();
  const log = ctx.log.child({ trigger: "cron", job: "places_refresh" });
  const result: PlacesRefreshResult = {
    candidates: 0,
    refreshed: 0,
    failed: 0,
    deferred: 0,
    rateLimited: false,
    received: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    rejected: 0,
    deleted: 0,
    enqueued: 0,
    requests: 0,
  };

  if (!configured(ctx.env)) {
    log.log("places.refresh.skipped", {
      level: "warn",
      reason: "not_configured",
      missing: ["GOOGLE_PLACES_API_KEY"],
    });
    return { ...result, skippedReason: "not_configured" };
  }

  const client = createPlacesClient({
    apiKey: (ctx.env.GOOGLE_PLACES_API_KEY as string).trim(),
    baseUrl: ctx.env.PLACES_API_BASE?.trim() || undefined,
    cache: kvPlacesCache(ctx.kv),
    fetch: ctx.fetch,
  });

  const window = refreshWindow(startedAt, { limit: ctx.limit });
  const candidates = await selectRefreshCandidates(ctx.db, window);
  result.candidates = candidates.length;
  log.log("places.refresh.started", {
    candidates: candidates.length,
    limit: window.limit,
    after_days: PLACES_REFRESH_AFTER_DAYS,
    oldest_run_at: candidates[0]?.lastRunAt.toISOString() ?? null,
  });

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i] as RefreshCandidate;
    const outcome = await refreshOne(ctx, client, candidate, log, now);
    result.requests = client.requests;
    if (outcome.status === "refreshed") {
      result.refreshed += 1;
      result.received += outcome.received;
      result.created += outcome.created;
      result.updated += outcome.updated;
      result.skipped += outcome.skipped;
      result.rejected += outcome.rejected;
      result.deleted += outcome.deleted;
      result.enqueued += outcome.enqueued;
    } else {
      result.failed += 1;
      if (outcome.rateLimited) {
        result.rateLimited = true;
        result.deferred = candidates.length - i - 1;
        log.log("places.refresh.rate_limited", {
          level: "warn",
          deferred: result.deferred,
        });
        break;
      }
    }
  }

  log.log("places.refresh.completed", {
    candidates: result.candidates,
    refreshed: result.refreshed,
    failed: result.failed,
    deferred: result.deferred,
    rate_limited: result.rateLimited,
    received: result.received,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    rejected: result.rejected,
    deleted: result.deleted,
    enqueued: result.enqueued,
    requests: result.requests,
    took_ms: now().getTime() - startedAt.getTime(),
  });
  return result;
}

type RefreshOutcome =
  | {
      status: "refreshed";
      received: number;
      created: number;
      updated: number;
      skipped: number;
      rejected: number;
      deleted: number;
      enqueued: number;
    }
  | { status: "failed"; rateLimited: boolean };

async function refreshOne(
  ctx: PlacesRefreshContext,
  client: PlacesClient,
  candidate: RefreshCandidate,
  parent: Logger,
  now: () => Date,
): Promise<RefreshOutcome> {
  const { db, queue } = ctx;
  const { projectId, environment, placeId } = candidate;
  const [opened] = await db
    .insert(ingestRuns)
    .values({
      projectId,
      environment,
      kind: "places",
      status: "running",
      artifactKey: `places:${placeId}`,
    })
    .returning({ id: ingestRuns.id });
  if (opened === undefined)
    throw new Error("ingest run insert returned no row");
  const log = parent.child({
    project_id: projectId,
    environment,
    place_id: placeId,
    ingest_run_id: opened.id,
    last_run_at: candidate.lastRunAt.toISOString(),
  });

  try {
    const { place: details } = await client.place(placeId, { fresh: true });
    const mapped = mapPlaceReviews(details);
    const returned = (details.reviews ?? []).map((r) => r.name);

    const upserted = await upsertReviews(db, {
      projectId,
      environment,
      reviews: mapped.reviews,
      onLimit: "truncate",
    });

    const deleted = await deleteStaleBootstrapRows(db, {
      projectId,
      environment,
      placeId,
      returned,
    });

    const messages: IngestMessage[] = upserted.toEnqueue;
    for (const batch of chunked(messages, QUEUE_SEND_BATCH_MAX)) {
      await queue.sendBatch(batch.map((body) => ({ body })));
    }

    const skipped = upserted.skipped + mapped.skipped.length;
    const rejected = upserted.rejected.length;
    await db
      .update(ingestRuns)
      .set({
        status: "succeeded",
        received: returned.length,
        created: upserted.created,
        updated: upserted.updated,
        skipped,
        failed: rejected,
        error: refreshNote({ deleted, rejected, limit: upserted.limit }),
        finishedAt: now(),
      })
      .where(eq(ingestRuns.id, opened.id));

    let generation: number | null = null;
    if (
      refreshChanged({
        created: upserted.created,
        deleted,
        enqueued: messages.length,
      })
    ) {
      // After the commits, never inside them (packages/core cache-generation).
      generation = await bumpProjectGeneration(ctx.kv, projectId);
    }
    if (rejected > 0) {
      log.log("places.refresh.cap_reached", {
        level: "warn",
        rejected,
        limit: upserted.limit,
        review_count: upserted.reviewCount,
      });
    }
    log.log("places.refresh.refreshed", {
      received: returned.length,
      created: upserted.created,
      updated: upserted.updated,
      skipped,
      rejected,
      deleted,
      enqueued: messages.length,
      generation,
    });
    return {
      status: "refreshed",
      received: returned.length,
      created: upserted.created,
      updated: upserted.updated,
      skipped,
      rejected,
      deleted,
      enqueued: messages.length,
    };
  } catch (error) {
    const places = error instanceof PlacesError ? error : null;
    const message = places
      ? describePlacesError(places)
      : error instanceof Error
        ? error.message
        : "unhandled error";
    await db
      .update(ingestRuns)
      .set({
        status: "failed",
        error: message.slice(0, 1000),
        finishedAt: now(),
      })
      .where(eq(ingestRuns.id, opened.id));
    if (places) {
      log.log("places.refresh.failed", {
        level: "warn",
        status: places.status,
        code: places.code,
        error_message: places.message,
      });
    } else {
      log.log("places.refresh.failed", { level: "error", error });
    }
    return { status: "failed", rateLimited: places?.status === 429 };
  }
}

/**
 * Delete the place's bootstrap rows Google no longer returns, lowering
 * `review_count` to match (floored at 0, as the api's DELETE does). Chunks
 * cascade. Returns the number deleted.
 */
export async function deleteStaleBootstrapRows(
  db: Db,
  input: {
    projectId: string;
    environment: RefreshCandidate["environment"];
    placeId: string;
    /** Review names Google returned for the place this time. */
    returned: readonly string[];
  },
): Promise<number> {
  const stored = await db
    .select({ id: reviews.id, externalId: reviews.externalId })
    .from(reviews)
    .where(
      and(
        eq(reviews.projectId, input.projectId),
        eq(reviews.environment, input.environment),
        eq(reviews.source, "google"),
        like(reviews.externalId, `${PLACES_BOOTSTRAP_PREFIX}%`),
        sql`${reviews.metadata}->>'place_id' = ${input.placeId}`,
      ),
    );
  const plan = planReconcile(
    stored.map((r) => r.externalId),
    input.returned,
  );
  if (plan.remove.length === 0) return 0;
  const remove = new Set(plan.remove);
  const ids = stored.filter((r) => remove.has(r.externalId)).map((r) => r.id);
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(reviews)
      .where(inArray(reviews.id, ids))
      .returning({ id: reviews.id });
    if (deleted.length > 0) {
      await tx
        .update(projects)
        .set({
          reviewCount: sql`GREATEST(${projects.reviewCount} - ${deleted.length}, 0)`,
        })
        .where(eq(projects.id, input.projectId));
    }
    return deleted.length;
  });
}
