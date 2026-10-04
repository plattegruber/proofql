/**
 * Benchmark for `searchChunks` (#16): how long does the exact per-tenant
 * scan take at the top of the free tier?
 *
 *   DATABASE_URL=postgres://proofql:proofql@localhost:54323/proofql \
 *     pnpm --filter @proofql/db exec tsx scripts/bench-search.ts [chunks] [--explain]
 *
 * Clones the migrated `proofql_template` (run `pnpm test:integration` once
 * so it exists), seeds one tenant with `chunks` embedded chunks (default
 * 5,000: 2,500 reviews x {full, window}) plus a second tenant of the same
 * size so the `(project_id, environment)` filter is doing real work, then
 * times hybrid, vector-only and no-query searches. Fake embeddings from
 * `@proofql/ai`: the arithmetic pgvector does is identical for real ones.
 * The two fixed chunks per review are a shape for the *scan*, not the
 * chunker's output: since #127 a real review averages ~4 chunks (full,
 * windows, one per sentence) on the demo corpus, so read the results as
 * "per 1,000 chunks" and convert with `docs/performance.md` §2.
 *
 * ## Against an existing multi-tenant database
 *
 *   DATABASE_URL=… pnpm load:seed                     # 21 tenants, 90k chunks
 *   DATABASE_URL=… pnpm --filter @proofql/db exec tsx scripts/bench-search.ts \
 *     --project load-01 [--explain]                    # or load-large
 *
 * `--project <slug|uuid>` skips the clone and the seed and times the same
 * scenarios against the named project in `DATABASE_URL` as it is (a slug
 * is not unique across accounts — the demo seed and the dashboard's local
 * stub both own a `cedar-ridge-dental` — so pass the id when it matters:
 * the demo project is `de300000-0000-4000-8000-000000000002`). The
 * two-tenant database cannot show costs that scale with the *table*
 * rather than the tenant — the `reviews` join of #111 was invisible to it
 * (`docs/performance.md` §2) — so re-run this mode on the load database
 * after any change to the statement.
 *
 * `--explain` prints `EXPLAIN (ANALYZE, BUFFERS)` for the hybrid and the
 * recency statements after the timings.
 *
 * Not a test: numbers depend on the machine. The figure quoted in
 * `src/queries/searchChunks.ts` came from this script.
 */

import { fakeEmbed } from "@proofql/ai";
import { sql as dsql } from "drizzle-orm";
import postgres from "postgres";

import { createDb } from "../src/client.js";
import { searchChunks, searchChunksSql } from "../src/queries/searchChunks.js";
import { reviewChunks } from "../src/schema/reviewChunks.js";
import { reviews } from "../src/schema/reviews.js";
import { accounts, projects } from "../src/schema/tenancy.js";
import { TEMPLATE_DB, withDatabase } from "../test/support.js";
import { parseScriptArgs } from "./args.js";

const TOPICS = [
  "The implant procedure was painless and quick",
  "Front desk explained every charge before I paid",
  "Parking behind the building was easy to find",
  "My kids actually look forward to the cleaning appointments",
  "Invisalign results after a year are better than I hoped",
  "Emergency root canal on a Saturday, no upsell, no drama",
  "Hygienist was gentle and thorough with my sensitive gums",
  "Whitening made a visible difference for my wedding photos",
];

function reviewText(i: number): string {
  const a = TOPICS[i % TOPICS.length] ?? "";
  const b = TOPICS[(i * 7 + 3) % TOPICS.length] ?? "";
  return `${a}. Visit number ${i} for our family. ${b}.`;
}

async function seedTenant(
  db: ReturnType<typeof createDb>["db"],
  slug: string,
  chunkCount: number,
): Promise<string> {
  const [acct] = await db
    .insert(accounts)
    .values({ clerkOrgId: `org_bench_${slug}`, name: slug })
    .returning();
  const [proj] = await db
    .insert(projects)
    .values({ accountId: acct?.id ?? "", name: slug, slug })
    .returning();
  const projectId = proj?.id ?? "";
  const reviewCount = Math.ceil(chunkCount / 2);

  const BATCH = 250;
  for (let start = 0; start < reviewCount; start += BATCH) {
    const n = Math.min(BATCH, reviewCount - start);
    const inserted = await db
      .insert(reviews)
      .values(
        Array.from({ length: n }, (_, j) => {
          const i = start + j;
          return {
            projectId,
            environment: "live" as const,
            source: i % 3 === 0 ? "yelp" : "google",
            externalId: `bench_${i}`,
            rating: 3 + (i % 3), // 3, 4, 5
            text: reviewText(i),
            authorName: `Author ${i}`,
            occurredAt: new Date(Date.UTC(2024, 0, 1) + i * 3_600_000),
            metadata: { location: i % 2 === 0 ? "north" : "south" },
          };
        }),
      )
      .returning({ id: reviews.id, text: reviews.text });

    const chunkRows = inserted.flatMap((r) => {
      const window = r.text.slice(0, r.text.indexOf(".") + 1);
      const [full, win] = fakeEmbed([r.text, window]);
      return [
        {
          reviewId: r.id,
          projectId,
          environment: "live" as const,
          kind: "full" as const,
          text: r.text,
          startOffset: 0,
          embedding: full ?? null,
        },
        {
          reviewId: r.id,
          projectId,
          environment: "live" as const,
          kind: "window" as const,
          text: window,
          startOffset: 0,
          embedding: win ?? null,
        },
      ];
    });
    await db.insert(reviewChunks).values(chunkRows);
  }
  return projectId;
}

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return `median ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${(sorted.at(-1) ?? 0).toFixed(1)} ms (n=${samples.length})`;
}

/**
 * Time every scenario against `projectId`, then (with `explain`) print
 * the hybrid plan.
 */
async function runScenarios(
  db: ReturnType<typeof createDb>["db"],
  sql: ReturnType<typeof createDb>["sql"],
  projectId: string,
  explain: boolean,
): Promise<void> {
  const [counted] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM review_chunks WHERE project_id = ${projectId}`;
  const [table] = await sql<{ reviews: string; chunks: string }[]>`
    SELECT (SELECT count(*) FROM reviews)::text AS reviews,
           (SELECT count(*) FROM review_chunks)::text AS chunks`;
  console.log(
    `tenant has ${counted?.count} chunks; table has ${table?.reviews} reviews / ${table?.chunks} chunks\n`,
  );

  const queryText = "painless implant";
  const [queryEmbedding] = fakeEmbed([queryText]);
  const base = {
    projectId,
    environment: "live" as const,
    limit: 5,
    policy: { minRating: 4, similarityFloor: 0.3 },
    mode: "excerpts" as const,
  };

  const scenarios = {
    "hybrid (vector + fts)": { ...base, queryEmbedding, queryText },
    "vector only": { ...base, queryEmbedding },
    "hybrid + metadata filter": {
      ...base,
      queryEmbedding,
      queryText,
      filters: { metadata: { location: "north" } },
    },
    "hybrid, includeBelowFloor": {
      ...base,
      queryEmbedding,
      queryText,
      includeBelowFloor: true,
    },
    "no query (recency)": base,
  };

  for (const [name, params] of Object.entries(scenarios)) {
    const samples: number[] = [];
    let rows = 0;
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      const results = await searchChunks(db, params);
      samples.push(performance.now() - t0);
      rows = results.length;
    }
    // Discard the first (cold) sample from the stats; report it separately.
    const [cold = 0, ...warm] = samples;
    console.log(
      `${name}: ${stats(warm)}; cold ${cold.toFixed(1)} ms; ${rows} rows`,
    );
  }

  if (explain) {
    // The two statements with their own access paths into `reviews`: the
    // hybrid join (#111) and the recency index scan (#117).
    for (const name of [
      "hybrid (vector + fts)",
      "no query (recency)",
    ] as const) {
      const plan = await db.execute<{ "QUERY PLAN": string }>(
        dsql`EXPLAIN (ANALYZE, BUFFERS) ${searchChunksSql(scenarios[name])}`,
      );
      console.log(`\n${name}:\n${plan.map((r) => r["QUERY PLAN"]).join("\n")}`);
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function benchExisting(
  databaseUrl: string,
  slug: string,
  explain: boolean,
): Promise<void> {
  const { db, sql } = createDb(databaseUrl, { max: 1 });
  try {
    const matches = await sql<{ id: string; slug: string }[]>`
      SELECT id, slug FROM projects
      WHERE ${UUID.test(slug) ? sql`id = ${slug}` : sql`slug = ${slug}`}
      ORDER BY created_at`;
    const [found] = matches;
    if (!found) throw new Error(`no project matches ${JSON.stringify(slug)}`);
    if (matches.length > 1) {
      console.warn(
        `warning: ${matches.length} projects have slug ${JSON.stringify(slug)} ` +
          `(${matches.map((m) => m.id).join(", ")}); using the oldest. ` +
          "Pass the id to pick one.",
      );
    }
    console.log(
      `project ${found.slug} (${found.id}) in ${new URL(databaseUrl).pathname.slice(1)}`,
    );
    await runScenarios(db, sql, found.id, explain);
  } finally {
    await sql.end();
  }
}

async function benchSeeded(
  databaseUrl: string,
  chunkCount: number,
  explain: boolean,
): Promise<void> {
  const benchDb = `bench_search_${process.pid}`;

  const maintenance = postgres(withDatabase(databaseUrl, "postgres"), {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  await maintenance.unsafe(
    `CREATE DATABASE "${benchDb}" TEMPLATE "${TEMPLATE_DB}"`,
  );

  const { db, sql } = createDb(withDatabase(databaseUrl, benchDb), { max: 1 });
  try {
    console.log(`seeding 2 tenants x ${chunkCount} chunks...`);
    const projectId = await seedTenant(db, "bench-a", chunkCount);
    await seedTenant(db, "bench-b", chunkCount);
    await sql`ANALYZE review_chunks`;
    await sql`ANALYZE reviews`;
    await runScenarios(db, sql, projectId, explain);
  } finally {
    await sql.end();
    await maintenance.unsafe(
      `DROP DATABASE IF EXISTS "${benchDb}" WITH (FORCE)`,
    );
    await maintenance.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  // `[chunks] [--project <slug|uuid>] [--explain]`; parseScriptArgs drops the
  // `--` pnpm forwards when run as a package script (#128, `scripts/args.ts`).
  const { values, positionals } = parseScriptArgs({
    options: {
      project: { type: "string" },
      explain: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (values.project !== undefined) {
    if (values.project === "" || values.project.startsWith("-")) {
      throw new Error("--project requires a project slug");
    }
    await benchExisting(databaseUrl, values.project, values.explain);
    return;
  }
  const [chunks = "5000"] = positionals;
  const chunkCount = Number(chunks);
  if (!Number.isInteger(chunkCount) || chunkCount <= 0) {
    throw new Error(
      `chunks must be a positive integer, got ${JSON.stringify(chunks)}`,
    );
  }
  await benchSeeded(databaseUrl, chunkCount, values.explain);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
