/**
 * Load-test seed (#50) — many tenants, one big one, and the keys to hit
 * them with.
 *
 *   pnpm load:seed                       # defaults below
 *   LOAD_PROJECTS=20 LOAD_REVIEWS=1000 LOAD_LARGE_CHUNKS=50000 pnpm load:seed
 *
 * Creates one account (`clerk_org_id = org_load_proofql`, wiped and
 * recreated on every run exactly like the demo seed) with
 * `LOAD_PROJECTS` ordinary projects of `LOAD_REVIEWS` reviews each plus one
 * "large tenant" project holding `LOAD_LARGE_CHUNKS` embedded chunks, the
 * line at which scope.md §2 says the exact per-tenant scan must be
 * revisited. Every review gets two chunks — its `full` text and a `window`
 * of its first sentence — embedded with `fakeEmbed` from `@proofql/ai`, the
 * same provider the api worker uses under `wrangler dev`, so a query built
 * from the same topic sentences lands above the project's similarity floor
 * and the response path does real serialization work.
 *
 * Per project it mints `LOAD_PUBLISHABLE_KEYS` publishable and
 * `LOAD_SECRET_KEYS` secret live keys. Rate limits are per key
 * (workers/api/src/rate-limit.ts), so the k6 script round-robins across
 * them to reach a target RPS without touching the worker's limits. The
 * plaintexts are written to `load/.keys.json` (gitignored) and nowhere
 * else; reseeding replaces them.
 *
 * The account is on the `paid` plan by default (`LOAD_PLAN=free` to
 * change): a 25,000-review tenant is over the free cap by definition, and
 * the paid rate limits (600 / 1,000 per minute per key) keep the key count
 * sane. Nothing on the query path reads the plan except the badge flag,
 * the limiter and the quota, so the latency numbers do not depend on it.
 *
 * Runs against `DATABASE_URL` (default: the compose Postgres) and refuses a
 * non-loopback host unless `--force` is passed, through the same guard as
 * the demo seed. Not a workspace: imports the packages by relative path and
 * runs under `packages/db`'s `tsx` (see the root `load:seed` script).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fakeEmbed } from "../../packages/ai/src/index.js";
import { generateApiKey } from "../../packages/core/src/index.js";
import { createDb, schema } from "../../packages/db/src/index.js";
import {
  assertSeedTargetAllowed,
  SeedGuardError,
} from "../../packages/db/src/seed/guard.js";

const LOCAL_DATABASE_URL = "postgres://proofql:proofql@localhost:54323/proofql";

/** The account the whole dataset hangs off; the only row the seed looks for. */
export const LOAD_ACCOUNT_CLERK_ORG_ID = "org_load_proofql";

/**
 * The topic sentences every review is built from. `load/k6/query.js` keeps
 * an identical copy: a query that is one of these lines is a `window`
 * chunk's exact text (cosine 1.0 under the fake embedder), so it clears the
 * default 0.55 floor and returns `limit` rows.
 */
export const TOPICS = [
  "The implant procedure was painless and quick",
  "Front desk explained every charge before I paid",
  "Parking behind the building was easy to find",
  "My kids actually look forward to the cleaning appointments",
  "Invisalign results after a year are better than I hoped",
  "Emergency root canal on a Saturday, no upsell, no drama",
  "Hygienist was gentle and thorough with my sensitive gums",
  "Whitening made a visible difference for my wedding photos",
  "The night guard fit perfectly on the first try",
  "Billing sorted out my insurance claim without me asking",
  "Sedation for the extraction was calm and well explained",
  "Same-day crown saved me a second trip across town",
] as const;

interface Config {
  databaseUrl: string;
  force: boolean;
  projects: number;
  reviewsPerProject: number;
  largeChunks: number;
  publishableKeys: number;
  secretKeys: number;
  plan: "free" | "paid";
  origin: string;
  outFile: string;
}

export interface SeededProject {
  slug: string;
  id: string;
  reviews: number;
  chunks: number;
  publishable: string[];
  secret: string[];
}

export interface KeysFile {
  seededAt: string;
  databaseHost: string;
  plan: string;
  /** The `Origin` the publishable keys are allowed from. */
  origin: string;
  topics: readonly string[];
  projects: SeededProject[];
  large: SeededProject;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  }
  return n;
}

function readConfig(): Config {
  const here = dirname(fileURLToPath(import.meta.url));
  const plan = process.env.LOAD_PLAN ?? "paid";
  if (plan !== "free" && plan !== "paid") {
    throw new Error(`LOAD_PLAN must be free or paid, got ${plan}`);
  }
  return {
    databaseUrl: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
    force: process.argv.includes("--force"),
    projects: intEnv("LOAD_PROJECTS", 20),
    reviewsPerProject: intEnv("LOAD_REVIEWS", 1000),
    largeChunks: intEnv("LOAD_LARGE_CHUNKS", 50_000),
    publishableKeys: intEnv("LOAD_PUBLISHABLE_KEYS", 12),
    secretKeys: intEnv("LOAD_SECRET_KEYS", 2),
    plan,
    origin: process.env.LOAD_ORIGIN ?? "http://localhost:3000",
    outFile: process.env.KEYS_FILE ?? join(here, "..", ".keys.json"),
  };
}

/** Deterministic review text: topic a, a per-review sentence, topic b. */
function reviewText(i: number): string {
  const a = TOPICS[i % TOPICS.length] ?? "";
  const b = TOPICS[(i * 7 + 3) % TOPICS.length] ?? "";
  return `${a}. Visit number ${i} for our family. ${b}.`;
}

/** Rows per multi-row INSERT; each chunk row carries a ~10 KB vector literal. */
const REVIEW_BATCH = 250;

type Db = ReturnType<typeof createDb>["db"];

async function seedProject(
  db: Db,
  accountId: string,
  cfg: Config,
  slug: string,
  reviewCount: number,
): Promise<SeededProject> {
  const { projects, reviews, reviewChunks, apiKeys } = schema;
  const [project] = await db
    .insert(projects)
    .values({
      accountId,
      name: slug,
      slug,
      allowedOrigins: [cfg.origin],
      reviewCount,
    })
    .returning({ id: projects.id });
  if (!project) throw new Error(`seed-load: project ${slug} was not inserted`);
  const projectId = project.id;

  const minted = await Promise.all([
    ...Array.from({ length: cfg.publishableKeys }, () =>
      generateApiKey({ kind: "publishable", environment: "live" }),
    ),
    ...Array.from({ length: cfg.secretKeys }, () =>
      generateApiKey({ kind: "secret", environment: "live" }),
    ),
  ]);
  if (minted.length > 0) {
    await db.insert(apiKeys).values(
      minted.map((key) => ({
        projectId,
        kind: key.kind,
        environment: key.environment,
        keyHash: key.hash,
        prefix: key.prefix,
      })),
    );
  }

  let chunks = 0;
  for (let start = 0; start < reviewCount; start += REVIEW_BATCH) {
    const n = Math.min(REVIEW_BATCH, reviewCount - start);
    const inserted = await db
      .insert(reviews)
      .values(
        Array.from({ length: n }, (_, j) => {
          const i = start + j;
          // 3, 4, 5 — a third fall under min_rating 4. Cycles per topic
          // round, not per review, so no topic is pinned to one rating.
          const rating = 3 + (Math.floor(i / TOPICS.length) % 3);
          return {
            projectId,
            environment: "live" as const,
            source: i % 3 === 0 ? "yelp" : "google",
            externalId: `load_${i}`,
            rating,
            text: reviewText(i),
            authorName: `Author ${i}`,
            occurredAt: new Date(Date.UTC(2024, 0, 1) + i * 3_600_000),
            url: `https://example.com/reviews/${slug}/${i}`,
            metadata: { location: i % 2 === 0 ? "north" : "south" },
            sentiment:
              rating >= 4 ? ("positive" as const) : ("neutral" as const),
            sentimentSource: "rating" as const,
            indexedAt: new Date(),
          };
        }),
      )
      .returning({ id: reviews.id, text: reviews.text });

    const chunkRows = inserted.flatMap((r) => {
      // `window` = the first sentence, a verbatim slice at offset 0.
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
    chunks += chunkRows.length;
  }

  return {
    slug,
    id: projectId,
    reviews: reviewCount,
    chunks,
    publishable: minted
      .filter((k) => k.kind === "publishable")
      .map((k) => k.plaintext),
    secret: minted.filter((k) => k.kind === "secret").map((k) => k.plaintext),
  };
}

async function main(): Promise<void> {
  const cfg = readConfig();
  assertSeedTargetAllowed({ databaseUrl: cfg.databaseUrl, force: cfg.force });

  const { db, sql } = createDb(cfg.databaseUrl, { max: 1 });
  const started = Date.now();
  try {
    const { accounts } = schema;
    // Wipe: one DELETE, cascades take projects, keys, reviews, chunks, usage.
    await sql`DELETE FROM accounts WHERE clerk_org_id = ${LOAD_ACCOUNT_CLERK_ORG_ID}`;
    const [account] = await db
      .insert(accounts)
      .values({
        clerkOrgId: LOAD_ACCOUNT_CLERK_ORG_ID,
        name: "ProofQL Load Test",
        plan: cfg.plan,
      })
      .returning({ id: accounts.id });
    if (!account) throw new Error("seed-load: account was not inserted");

    const projects: SeededProject[] = [];
    for (let p = 0; p < cfg.projects; p++) {
      const slug = `load-${String(p + 1).padStart(2, "0")}`;
      const seeded = await seedProject(
        db,
        account.id,
        cfg,
        slug,
        cfg.reviewsPerProject,
      );
      projects.push(seeded);
      console.log(
        `  ${slug}: ${seeded.reviews} reviews, ${seeded.chunks} chunks (${Math.round((Date.now() - started) / 1000)}s)`,
      );
    }

    const large = await seedProject(
      db,
      account.id,
      cfg,
      "load-large",
      Math.ceil(cfg.largeChunks / 2),
    );
    console.log(
      `  load-large: ${large.reviews} reviews, ${large.chunks} chunks (${Math.round((Date.now() - started) / 1000)}s)`,
    );

    // Fresh statistics so the planner sees the real per-tenant row counts.
    await sql`ANALYZE review_chunks`;
    await sql`ANALYZE reviews`;

    const out: KeysFile = {
      seededAt: new Date().toISOString(),
      databaseHost: new URL(cfg.databaseUrl).hostname,
      plan: cfg.plan,
      origin: cfg.origin,
      topics: TOPICS,
      projects,
      large,
    };
    mkdirSync(dirname(cfg.outFile), { recursive: true });
    writeFileSync(cfg.outFile, `${JSON.stringify(out, null, 2)}\n`, {
      mode: 0o600,
    });

    const totalChunks =
      projects.reduce((n, p) => n + p.chunks, 0) + large.chunks;
    console.log("");
    console.log(
      `Seeded ${projects.length} projects x ${cfg.reviewsPerProject} reviews + 1 large tenant (${large.chunks} chunks); ${totalChunks} chunks in all, ${Math.round((Date.now() - started) / 1000)}s.`,
    );
    console.log(
      `Account "${LOAD_ACCOUNT_CLERK_ORG_ID}" (${cfg.plan} plan); publishable keys allowed from ${cfg.origin}.`,
    );
    console.log(`Keys written to ${cfg.outFile} (LOCAL LOAD TEST ONLY).`);
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof SeedGuardError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
