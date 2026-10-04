/**
 * The demo seed (#20) — wipe-and-recreate the demo account, one transaction.
 *
 * - **Scoped.** The only row the seed ever looks for is the account with
 *   `clerk_org_id = 'org_demo_proofql'`. Deleting it cascades through
 *   projects → api_keys, reviews, review_chunks, usage, connections,
 *   ingest_runs. Nothing else in the database is touched.
 * - **Idempotent.** Delete-then-insert inside a transaction: a second run
 *   produces the same counts, and a mid-seed failure leaves the previous
 *   state, never a half-seeded account.
 * - **Deterministic data, fresh keys.** Account and project ids are fixed;
 *   review text, ratings, metadata, and `occurred_at` come from the fixture
 *   list and `SEED_ANCHOR`. API keys are minted fresh on every run (only
 *   their hashes are stored) and returned in the summary for the CLI to
 *   print once.
 * - **Same chunker as the pipeline.** Chunks come from `chunkReview` in
 *   `@proofql/core` with the review's `language` as the locale — exactly
 *   the call `workers/pipeline` makes — so a seeded review's chunks are
 *   byte-identical (same `full` + `window` + `sentence` boundaries, same
 *   UTF-16 offsets) to what ingesting it would produce. `assertVerbatimChunks`
 *   gates every chunk before insert, as it does on the pipeline write
 *   path. Embeddings come from `fakeEmbed` in `@proofql/ai`, so a query
 *   vector built with the same fake lands near the right rows. Sentiment is
 *   `sentimentFromRating` for rated reviews (`sentiment_source = 'rating'`)
 *   and the fixture's hand label for unrated ones (`'model'`, standing in
 *   for the classifier). `indexed_at` is set because chunks and embeddings
 *   exist — the API would report these reviews as searchable.
 */

import { fakeEmbed } from "@proofql/ai";
import {
  type ApiKeyEnvironment,
  type ApiKeyKind,
  assertVerbatimChunks,
  chunkReview,
  generateApiKey,
  sentimentFromRating,
} from "@proofql/core";
import { eq } from "drizzle-orm";

import type { Db } from "../client.js";
import { apiKeys } from "../schema/apiKeys.js";
import { reviewChunks } from "../schema/reviewChunks.js";
import { reviews } from "../schema/reviews.js";
import { accounts, projects } from "../schema/tenancy.js";
import {
  DEMO_ACCOUNT_CLERK_ORG_ID,
  DEMO_ACCOUNT_ID,
  DEMO_ACCOUNT_NAME,
  DEMO_ALLOWED_ORIGINS,
  DEMO_PROJECT_ID,
  DEMO_PROJECT_NAME,
  DEMO_PROJECT_SLUG,
  occurredAtFor,
  SEED_VERSION,
} from "./constants.js";
import {
  DEMO_REVIEW_FIXTURES,
  type DemoReviewFixture,
  demoExternalId,
  demoLanguage,
} from "./fixtures/reviews.js";

/** The account's display name carries the dataset version (see constants). */
export function demoAccountName(): string {
  return `${DEMO_ACCOUNT_NAME} (seed v${SEED_VERSION})`;
}

/** One pair (secret + publishable) per environment. */
const KEY_SPECS: readonly {
  kind: ApiKeyKind;
  environment: ApiKeyEnvironment;
}[] = [
  { kind: "secret", environment: "live" },
  { kind: "publishable", environment: "live" },
  { kind: "secret", environment: "test" },
  { kind: "publishable", environment: "test" },
];

export interface SeedKey {
  kind: ApiKeyKind;
  environment: ApiKeyEnvironment;
  /** Show once — the CLI prints it; nothing stores it. */
  plaintext: string;
  prefix: string;
}

export interface SeedSummary {
  seedVersion: number;
  accountId: string;
  projectId: string;
  reviews: { live: number; test: number };
  chunks: { full: number; window: number; sentence: number };
  keys: SeedKey[];
}

export interface RunSeedOptions {
  /** Stamp for `indexed_at`; defaults to the wall clock. */
  now?: Date;
}

/** Rows per multi-row INSERT; keeps each statement's parameter count sane. */
const INSERT_BATCH = 50;

/**
 * Wipe and recreate the demo account. Runs inside a single transaction.
 * Returns counts plus the freshly minted key plaintexts.
 */
export async function runSeed(
  db: Db,
  options: RunSeedOptions = {},
): Promise<SeedSummary> {
  const now = options.now ?? new Date();
  // Pure WebCrypto, no DB — mint before the transaction opens.
  const minted = await Promise.all(
    KEY_SPECS.map((spec) => generateApiKey(spec)),
  );

  return db.transaction(async (tx) => {
    // The wipe: one DELETE, cascades do the rest.
    await tx
      .delete(accounts)
      .where(eq(accounts.clerkOrgId, DEMO_ACCOUNT_CLERK_ORG_ID));

    await tx.insert(accounts).values({
      id: DEMO_ACCOUNT_ID,
      clerkOrgId: DEMO_ACCOUNT_CLERK_ORG_ID,
      name: demoAccountName(),
      plan: "free",
    });

    const liveCount = DEMO_REVIEW_FIXTURES.filter(
      (f) => f.environment === "live",
    ).length;

    await tx.insert(projects).values({
      id: DEMO_PROJECT_ID,
      accountId: DEMO_ACCOUNT_ID,
      name: DEMO_PROJECT_NAME,
      slug: DEMO_PROJECT_SLUG,
      allowedOrigins: [...DEMO_ALLOWED_ORIGINS],
      reviewCount: liveCount,
    });

    await tx.insert(apiKeys).values(
      minted.map((key) => ({
        projectId: DEMO_PROJECT_ID,
        kind: key.kind,
        environment: key.environment,
        keyHash: key.hash,
        prefix: key.prefix,
      })),
    );

    // Reviews, in fixture batches; keep the returned ids to parent chunks.
    const inserted: { id: string; key: string; fixture: DemoReviewFixture }[] =
      [];
    for (const batch of batches(DEMO_REVIEW_FIXTURES, INSERT_BATCH)) {
      const rows = await tx
        .insert(reviews)
        .values(batch.map((fixture) => reviewRow(fixture, now)))
        .returning({ id: reviews.id, externalId: reviews.externalId });
      const byExternalId = new Map(rows.map((r) => [r.externalId, r.id]));
      for (const fixture of batch) {
        const id = byExternalId.get(demoExternalId(fixture));
        if (!id)
          throw new Error(`seed: review ${fixture.key} was not inserted`);
        inserted.push({ id, key: fixture.key, fixture });
      }
    }

    // Chunks: the pipeline's chunker, gated the way the pipeline gates it.
    type ChunkInsert = typeof reviewChunks.$inferInsert;
    const chunkRows: ChunkInsert[] = [];
    for (const { id, fixture } of inserted) {
      const chunks = chunkReview(fixture.text, {
        locale: demoLanguage(fixture),
      });
      assertVerbatimChunks(fixture.text, chunks);
      const vectors = fakeEmbed(chunks.map((c) => c.text));
      chunks.forEach((chunk, i) => {
        chunkRows.push({
          reviewId: id,
          projectId: DEMO_PROJECT_ID,
          environment: fixture.environment,
          kind: chunk.kind,
          text: chunk.text,
          startOffset: chunk.startOffset,
          embedding: vectors[i],
        });
      });
    }
    for (const batch of batches(chunkRows, INSERT_BATCH)) {
      await tx.insert(reviewChunks).values(batch);
    }

    return {
      seedVersion: SEED_VERSION,
      accountId: DEMO_ACCOUNT_ID,
      projectId: DEMO_PROJECT_ID,
      reviews: {
        live: liveCount,
        test: DEMO_REVIEW_FIXTURES.length - liveCount,
      },
      chunks: {
        full: chunkRows.filter((c) => c.kind === "full").length,
        window: chunkRows.filter((c) => c.kind === "window").length,
        sentence: chunkRows.filter((c) => c.kind === "sentence").length,
      },
      keys: minted.map((key) => ({
        kind: key.kind,
        environment: key.environment,
        plaintext: key.plaintext,
        prefix: key.prefix,
      })),
    };
  });
}

function reviewRow(
  fixture: DemoReviewFixture,
  now: Date,
): typeof reviews.$inferInsert {
  const rated = fixture.rating !== null;
  const sentiment = rated
    ? sentimentFromRating(fixture.rating)
    : (fixture.sentiment ?? null);
  return {
    projectId: DEMO_PROJECT_ID,
    environment: fixture.environment,
    source: fixture.source,
    externalId: demoExternalId(fixture),
    rating: fixture.rating,
    text: fixture.text,
    authorName: fixture.authorName,
    occurredAt: occurredAtFor(fixture.key, fixture.daysAgo),
    url: sourceUrl(fixture),
    language: demoLanguage(fixture),
    metadata: { location: fixture.location },
    sentiment,
    sentimentSource: sentiment === null ? null : rated ? "rating" : "model",
    indexedAt: now,
  };
}

/** Plausible, obviously fake attribution URLs; null for the custom source. */
function sourceUrl(fixture: DemoReviewFixture): string | null {
  switch (fixture.source) {
    case "google":
      return `https://maps.google.com/maps/reviews/demo/${fixture.key}`;
    case "yelp":
      return `https://www.yelp.com/biz/cedar-ridge-dental-demo?hrid=${fixture.key}`;
    default:
      return null;
  }
}

function* batches<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
