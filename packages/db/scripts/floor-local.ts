/**
 * Ops: collect a floor-tuning run **locally** (#151), with no api and no
 * Workers AI traffic.
 *
 * `tune-floor.ts` collects its runs through a deployed api, which embeds
 * every query with Workers AI and reads the deployed database. That costs
 * free-plan quota and only sees the demo project. This script does the
 * same collection against a local Postgres instead: it loads a labelled
 * corpus into a scratch project, embeds nothing itself, and runs every
 * query through `searchChunks` — the statement the api runs — with the
 * same settings a scratch run uses (mode `reviews`, limit 20, floor 0.30,
 * min_rating 4). The output is a `SavedRun`, so the existing harness
 * reads it unchanged:
 *
 *     pnpm db:tune-floor -- --annotate <run> --category roofing   # same DATABASE_URL
 *     pnpm db:tune-floor -- --replay <run> --two-tier
 *
 * Vectors come from a JSON file mapping each text to its bge-m3 embedding
 * (`{ "model": "...", "vectors": { "<text>": [1024 numbers] } }`), so any
 * bge-m3 can produce them once and the run replays from the cache. For
 * #151 they were computed on a laptop with `sentence-transformers` and
 * `BAAI/bge-m3`, the model Workers AI serves as `@cf/baai/bge-m3`
 * (docs/performance.md §5 "Generic words from the category"). `--emit-texts`
 * writes the texts a corpus needs (every chunk the pipeline's chunker
 * makes, and every query) so the embedder knows what to do.
 *
 *     createdb + migrate a scratch database once:
 *       docker compose exec db createdb -U proofql proofql_floor
 *       DATABASE_URL=postgres://proofql:proofql@localhost:54323/proofql_floor pnpm db:migrate
 *     DATABASE_URL=…/proofql_floor pnpm db:floor-local -- --corpus roofing --emit-texts texts.json
 *     # embed texts.json with bge-m3 into vectors.json, then:
 *     DATABASE_URL=…/proofql_floor pnpm db:floor-local -- --corpus roofing \
 *       --vectors vectors.json --out docs/floor-tuning/<date>-roofing-local.json
 *
 * Arguments:
 *   --corpus <c>      `dental` (the demo corpus and its 59 fixtures) or
 *                     `roofing` (`src/seed/fixtures/relevance-roofing.ts`)
 *   --vectors <path>  the embedding cache (required unless --emit-texts)
 *   --emit-texts <p>  write the texts that need vectors and exit
 *   --out <path>      where to save the run (required with --vectors)
 *   --embedding <s>   recorded as `source.embedding` (default: the model
 *                     named in the vectors file)
 *
 * Refuses a non-loopback DATABASE_URL: it deletes and recreates its
 * scratch account. Chunks stay in the database after the run, so
 * `--annotate` can read them by id.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertVerbatimChunks,
  type BusinessCategory,
  chunkReview,
  type Sentiment,
  sentimentFromRating,
} from "@proofql/core";
import { eq } from "drizzle-orm";

import { createDb, type Db } from "../src/client.js";
import { searchChunks } from "../src/queries/searchChunks.js";
import { reviewChunks } from "../src/schema/reviewChunks.js";
import { reviews } from "../src/schema/reviews.js";
import { accounts, projects } from "../src/schema/tenancy.js";
import {
  RELEVANCE_QUERIES,
  type RelevanceQuery,
} from "../src/seed/fixtures/relevance.js";
import {
  ROOFING_QUERIES,
  ROOFING_REVIEWS,
} from "../src/seed/fixtures/relevance-roofing.js";
import {
  DEMO_LIVE_REVIEWS,
  demoLanguage,
} from "../src/seed/fixtures/reviews.js";
import { assertSeedTargetAllowed } from "../src/seed/guard.js";
import { parseScriptArgs } from "./args.js";
import { computeCurve } from "./floor-curve.js";
import type { SavedRun } from "./tune-floor.js";

/** The scratch floor and policy of a collection run (tune-floor's module doc). */
export const SCRATCH_FLOOR = 0.3;
const MIN_RATING = 4;
const LIMIT = 20;

interface CorpusReview {
  key: string;
  rating: number | null;
  sentiment: Sentiment | null;
  text: string;
  language: string;
}

export interface Corpus {
  name: "dental" | "roofing";
  category: BusinessCategory;
  reviews: CorpusReview[];
  queries: readonly RelevanceQuery[];
}

export function corpusFor(name: string): Corpus {
  if (name === "dental") {
    return {
      name,
      category: "dental",
      reviews: DEMO_LIVE_REVIEWS.map((f) => ({
        key: f.key,
        rating: f.rating,
        sentiment:
          f.rating === null
            ? (f.sentiment ?? null)
            : sentimentFromRating(f.rating),
        text: f.text,
        language: demoLanguage(f),
      })),
      queries: RELEVANCE_QUERIES,
    };
  }
  if (name === "roofing") {
    return {
      name,
      category: "roofing",
      reviews: ROOFING_REVIEWS.map((r) => ({
        key: r.key,
        rating: r.rating,
        sentiment: sentimentFromRating(r.rating),
        text: r.text,
        language: "en",
      })),
      queries: ROOFING_QUERIES,
    };
  }
  throw new Error(`--corpus must be dental or roofing, got ${name}`);
}

/** Every text the corpus needs a vector for: chunks, then queries. */
export function corpusTexts(corpus: Corpus): string[] {
  const texts = new Set<string>();
  for (const review of corpus.reviews) {
    for (const chunk of chunkReview(review.text, { locale: review.language })) {
      texts.add(chunk.text);
    }
  }
  for (const query of corpus.queries) texts.add(query.q);
  return [...texts];
}

/** Fixed ids per corpus, so a re-run replaces its own scratch rows only. */
function scratchIds(corpus: Corpus) {
  const n = corpus.name === "dental" ? "1" : "2";
  return {
    accountId: `f1004000-0000-4000-8000-00000000000${n}`,
    clerkOrgId: `org_floor_local_${corpus.name}`,
    projectId: `f1004000-0000-4000-8000-00000000010${n}`,
  };
}

async function load(
  db: Db,
  corpus: Corpus,
  vectors: ReadonlyMap<string, number[]>,
): Promise<{ projectId: string; keyByReviewId: Map<string, string> }> {
  const ids = scratchIds(corpus);
  return db.transaction(async (tx) => {
    await tx.delete(accounts).where(eq(accounts.clerkOrgId, ids.clerkOrgId));
    await tx.insert(accounts).values({
      id: ids.accountId,
      clerkOrgId: ids.clerkOrgId,
      name: `floor-local ${corpus.name}`,
    });
    await tx.insert(projects).values({
      id: ids.projectId,
      accountId: ids.accountId,
      name: `floor-local ${corpus.name}`,
      slug: `floor-local-${corpus.name}`,
      category: corpus.category,
      similarityFloor: SCRATCH_FLOOR,
      minRating: MIN_RATING,
      reviewCount: corpus.reviews.length,
    });
    const keyByReviewId = new Map<string, string>();
    for (const [i, review] of corpus.reviews.entries()) {
      const [row] = await tx
        .insert(reviews)
        .values({
          projectId: ids.projectId,
          environment: "live",
          source: "custom",
          externalId: `floor-${review.key}`,
          rating: review.rating,
          text: review.text,
          authorName: `Reviewer ${review.key}`,
          // Distinct, ordered dates keep the recency tie-breaks stable.
          occurredAt: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000),
          language: review.language,
          metadata: {},
          sentiment: review.sentiment,
          sentimentSource: review.rating === null ? "model" : "rating",
          indexedAt: new Date(),
        })
        .returning({ id: reviews.id });
      if (!row) throw new Error(`review ${review.key} was not inserted`);
      keyByReviewId.set(row.id, review.key);
      const chunks = chunkReview(review.text, { locale: review.language });
      assertVerbatimChunks(review.text, chunks);
      await tx.insert(reviewChunks).values(
        chunks.map((chunk) => ({
          reviewId: row.id,
          projectId: ids.projectId,
          environment: "live" as const,
          kind: chunk.kind,
          text: chunk.text,
          startOffset: chunk.startOffset,
          embedding: vectorFor(vectors, chunk.text),
        })),
      );
    }
    return { projectId: ids.projectId, keyByReviewId };
  });
}

function vectorFor(vectors: ReadonlyMap<string, number[]>, text: string) {
  const v = vectors.get(text);
  if (!v) {
    throw new Error(
      `no vector for ${JSON.stringify(text.slice(0, 60))}; re-run --emit-texts and embed`,
    );
  }
  return v;
}

async function collect(
  db: Db,
  corpus: Corpus,
  vectors: ReadonlyMap<string, number[]>,
  projectId: string,
  keyByReviewId: ReadonlyMap<string, string>,
): Promise<SavedRun["queries"]> {
  const out: SavedRun["queries"][number][] = [];
  for (const query of corpus.queries) {
    const started = performance.now();
    const rows = await searchChunks(db, {
      projectId,
      environment: "live",
      queryEmbedding: vectorFor(vectors, query.q),
      queryText: query.q,
      limit: LIMIT,
      mode: "reviews",
      policy: {
        minRating: MIN_RATING,
        similarityFloor: SCRATCH_FLOOR,
        category: corpus.category,
      },
    });
    out.push({
      id: query.id,
      q: query.q,
      kind: query.kind,
      ...(query.tags ? { tags: query.tags } : {}),
      expect: query.expect,
      ...(query.acceptable ? { acceptable: query.acceptable } : {}),
      rows: rows.flatMap((r) =>
        r.similarity === null
          ? []
          : [
              {
                key: keyByReviewId.get(r.reviewId) ?? `?${r.reviewId}`,
                similarity: r.similarity,
                review_id: r.reviewId,
                chunk_id: r.chunkId,
              },
            ],
      ),
      took_ms: Math.round(performance.now() - started),
    });
  }
  return out;
}

function readVectors(path: string): {
  model: string;
  map: Map<string, number[]>;
} {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    model?: string;
    vectors: Record<string, number[]>;
  };
  return {
    model: raw.model ?? "unknown",
    map: new Map(Object.entries(raw.vectors)),
  };
}

const INVOKED_FROM = process.env.INIT_CWD ?? process.cwd();

async function main(): Promise<void> {
  const { values } = parseScriptArgs({
    options: {
      corpus: { type: "string" },
      vectors: { type: "string" },
      "emit-texts": { type: "string" },
      out: { type: "string" },
      embedding: { type: "string" },
    },
  });
  const corpus = corpusFor(values.corpus ?? "");

  if (values["emit-texts"] !== undefined) {
    const texts = corpusTexts(corpus);
    const path = resolve(INVOKED_FROM, values["emit-texts"]);
    writeFileSync(path, `${JSON.stringify(texts, null, 2)}\n`);
    console.log(`db:floor-local: ${texts.length} texts → ${path}`);
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error("DATABASE_URL is required (a local scratch database)");
  assertSeedTargetAllowed({ databaseUrl: url, force: false });
  if (!values.vectors) throw new Error("--vectors is required");
  if (!values.out) throw new Error("--out is required");
  const vectors = readVectors(resolve(INVOKED_FROM, values.vectors));

  const { db, sql } = createDb(url, { max: 1 });
  try {
    const { projectId, keyByReviewId } = await load(db, corpus, vectors.map);
    const queries = await collect(
      db,
      corpus,
      vectors.map,
      projectId,
      keyByReviewId,
    );
    const run: SavedRun = {
      version: 1,
      generated_at: new Date().toISOString(),
      source: {
        api: `local searchChunks (scripts/floor-local.ts, corpus ${corpus.name})`,
        mode: "reviews",
        limit: LIMIT,
        embedding:
          values.embedding ?? `${vectors.model} (local, query and corpus)`,
        fixtures: corpus.queries.length,
        project_floor: SCRATCH_FLOOR,
      },
      queries,
      summary: computeCurve(queries),
    };
    const out = resolve(INVOKED_FROM, values.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
    console.log(
      `db:floor-local: ${queries.length} queries over ${corpus.reviews.length} ${corpus.name} reviews → ${out}`,
    );
  } finally {
    await sql.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(
      `db:floor-local: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
