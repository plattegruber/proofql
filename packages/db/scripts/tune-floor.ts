/**
 * Ops: measure the similarity floor on real embeddings (#138).
 *
 * Runs every query in `src/seed/fixtures/relevance.ts` against a deployed
 * api worker (so the query is embedded with Workers AI `bge-m3`, like
 * production), records each returned review's cosine `score`, and prints
 * precision, recall, and the false-positive rate on the must-be-empty
 * queries at every floor from 0.50 to 0.80, plus the score distributions
 * and a recommended default. The raw observations are saved so the curve
 * replays offline, byte for byte, without the api.
 *
 *     pnpm db:tune-floor -- --api https://proofql-api-preview.<sub>.workers.dev \
 *                           --key pq_pk_live_… --origin https://proofql-cdn-preview.<sub>.workers.dev
 *     pnpm db:tune-floor -- --replay docs/floor-tuning/2026-10-04.json [--at 0.63]
 *
 * The api applies the project's own floor inside the SQL, so a run only
 * sees candidates above it. To read scores *below* the current default the
 * demo project's floor has to be lowered for the duration of the run, and
 * this script deliberately does not touch the database. Do it by hand, on
 * the database the api you are pointing at reads (the demo project id is
 * `DEMO_PROJECT_ID`, `de300000-0000-4000-8000-000000000002`):
 *
 *     UPDATE projects SET similarity_floor = 0.30 WHERE id = 'de300000-0000-4000-8000-000000000002';
 *     -- run this script --
 *     UPDATE projects SET similarity_floor = <the default> WHERE id = 'de300000-0000-4000-8000-000000000002';
 *
 * The query cache keys on the floor (`workers/api/src/query/cache.ts`), so
 * the lowered run never reads a cached answer from the normal floor and
 * nothing it stores is served once the floor is restored; the script also
 * sends `Cache-Control: no-cache` so every request is a fresh embedding
 * and search. The script warns when no returned score is under 0.50,
 * which almost always means the floor was not lowered. The scratch floor
 * must be *below* the lowest floor you want on the curve (0.30 for the
 * default 0.50–0.80 range); the api caps `limit` at 20, so each query
 * contributes its top 20 reviews, which on the 67 publishable demo reviews
 * is every candidate that matters.
 *
 * The demo corpus must be indexed with real embeddings (`pnpm db:reindex`
 * after seeding, since the seed embeds with the fake): fake vectors against
 * a `bge-m3` query vector score near zero and the run reports nothing.
 * Reviews not in the fixtures (a `scripts/demo.sh` run in progress) are
 * recorded as `?<review id>` and count as false positives.
 *
 * Arguments:
 *   --api <url>        api worker origin (live mode)
 *   --key <pq_pk_…>    a *publishable* live key of the demo project
 *   --origin <url>     an origin in the project's allowed_origins
 *   --limit <n>        rows per query, 1–20 (default 20)
 *   --out <path>       where to save the run (default docs/floor-tuning/<date>.json)
 *   --replay <path>    offline: recompute the report from a saved run
 *   --at <floor>       also list every query's verdict at this floor
 *   --project-floor <x>  live mode: the project's similarity_floor during the
 *                      run, recorded in the JSON (0.30 for a scratch run; the
 *                      real floor for a validation run)
 *   --project-lexical-floor <x>  live mode: the project's lexical floor during
 *                      the run, when the two-tier floor is deployed
 *   --annotate <path>  offline, needs DATABASE_URL: mark each saved row
 *                      `lexical` (its chunk matches `websearch_to_tsquery`
 *                      the way the hybrid search's full-text branch does)
 *                      and rewrite the file; reads chunks only, no api
 *   --lexical-rule <r> with --annotate: which word-match rule to apply
 *                      (`all`, `any`, `half`, `half-specific`; default the
 *                      one `searchChunks` uses, `LEXICAL_RULE` in @proofql/core)
 *   --two-tier         with --replay: grid-search a two-tier floor (a chunk
 *                      passes at `high`, or at `low` when it is lexical) over
 *                      high 0.62–0.70 × low 0.50–0.60 and rank the pairs
 *                      with the negatives' FP rate ≤ 5% by per-page answers
 *
 * Caveat for offline grids: the search collapses each review to its best
 * chunk by *fused* rank, so a scratch run records one chunk per review —
 * usually but not always its most similar one, and its `lexical` flag is
 * that chunk's. A floor can therefore admit a review the replay misses
 * (through a sibling chunk). Validate a chosen setting with a live run at
 * that setting (`--project-floor` = the real floor): that run is exact.
 *
 * The saved key is never the plaintext of anything: the JSON holds query
 * texts, review keys, and scores only.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  GENERIC_QUERY_WORDS,
  LEXICAL_RULE,
  LEXICAL_RULES,
  type LexicalRule,
} from "@proofql/core";
import { sql as drizzleSql } from "drizzle-orm";

import { lexicalMatchSql } from "../src/queries/lexicalMatch.js";
import {
  RELEVANCE_QUERIES,
  type RelevanceQuery,
} from "../src/seed/fixtures/relevance.js";
import { DEMO_LIVE_REVIEWS } from "../src/seed/fixtures/reviews.js";
import { parseScriptArgs } from "./args.js";
import {
  type Curve,
  computeCurve,
  computeTwoTier,
  DEFAULT_CURVE_OPTIONS,
  type FloorPoint,
  isClean,
  type ObservedQuery,
  type ObservedRow,
  type QueryVerdict,
  tunedPositives,
  twoTier,
  verdictsAt,
  verdictsWith,
} from "./floor-curve.js";

/** One returned review as saved. */
export interface SavedRow extends ObservedRow {
  readonly review_id: string;
  /** The returned excerpt's chunk (`excerpt_id`); absent on the first run. */
  readonly chunk_id?: string;
}

/** Shape of `docs/floor-tuning/<date>.json`. */
export interface SavedRun {
  readonly version: 1;
  readonly generated_at: string;
  readonly source: {
    readonly api: string;
    readonly mode: "reviews";
    readonly limit: number;
    readonly embedding: string;
    readonly fixtures: number;
    /** The project's floor during the run (absent on the first run: 0.30). */
    readonly project_floor?: number;
    /** The project's lexical floor during the run, when two-tier is live. */
    readonly project_lexical_floor?: number;
  };
  readonly queries: readonly (ObservedQuery & {
    readonly rows: readonly SavedRow[];
  })[];
  /** Derived from `queries`; a replay recomputes and ignores it. */
  readonly summary: Curve;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

/**
 * Where relative `--replay`/`--out` paths start: the directory `pnpm` was
 * invoked from (`INIT_CWD`), not `packages/db`, which is where
 * `pnpm --filter` runs the script.
 */
const INVOKED_FROM = process.env.INIT_CWD ?? process.cwd();

function usage(message: string): never {
  console.error(`db:tune-floor: ${message}`);
  console.error(
    "usage: pnpm db:tune-floor -- --api <url> --key <pq_pk_…> --origin <url> [--limit 20] [--out <path>]\n" +
      "       pnpm db:tune-floor -- --replay <path> [--at <floor>]",
  );
  process.exit(1);
}

interface ApiResult {
  score: number | null;
  excerpt_id: string;
  review: { id: string; text?: string };
}

interface ApiResponse {
  results: ApiResult[];
  match: string;
}

const MAX_ATTEMPTS = 6;

/** One `/v1/query` with the snippet's auth, retrying 429/5xx with backoff. */
async function queryApi(
  api: string,
  key: string,
  origin: string,
  q: string,
  limit: number,
): Promise<ApiResponse> {
  const url = new URL("/v1/query", api);
  url.searchParams.set("key", key);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("mode", "reviews");
  url.searchParams.set("fallback", "none");
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: { Origin: origin, "Cache-Control": "no-cache" },
    });
    if (res.ok) return (await res.json()) as ApiResponse;
    const body = (await res.text()).slice(0, 300);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`GET /v1/query → HTTP ${res.status}: ${body}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** (attempt - 1);
    console.error(
      `  HTTP ${res.status} on "${q}", retrying in ${waitMs} ms (${attempt}/${MAX_ATTEMPTS})`,
    );
    await sleep(waitMs);
  }
}

/** Run the fixtures against the api; rows carry fixture keys. */
async function observe(
  api: string,
  key: string,
  origin: string,
  limit: number,
): Promise<SavedRun["queries"]> {
  const keyByText = new Map(DEMO_LIVE_REVIEWS.map((f) => [f.text, f.key]));
  const out: SavedRun["queries"][number][] = [];
  let unknown = 0;
  for (const [i, fixture] of RELEVANCE_QUERIES.entries()) {
    const res = await queryApi(api, key, origin, fixture.q, limit);
    const rows = res.results.flatMap((r) => {
      if (r.score === null) return [];
      const reviewKey = keyByText.get(r.review.text ?? "");
      if (reviewKey === undefined) unknown++;
      return [
        {
          key: reviewKey ?? `?${r.review.id}`,
          similarity: r.score,
          review_id: r.review.id,
          chunk_id: r.excerpt_id,
        },
      ];
    });
    out.push({ ...toObserved(fixture, []), rows });
    const top = rows[0];
    console.error(
      `  ${String(i + 1).padStart(2)}/${RELEVANCE_QUERIES.length} ${fixture.id} ${fixture.kind.padEnd(15)} ${rows.length.toString().padStart(2)} rows` +
        (top ? `  top ${top.key} ${top.similarity.toFixed(3)}` : "") +
        `  "${fixture.q}"`,
    );
    // Well under the publishable key's per-minute limit; keeps a load test
    // on the same api from seeing us as a burst.
    await sleep(150);
  }
  if (unknown > 0) {
    console.error(
      `  note: ${unknown} returned review(s) are not in the fixtures (recorded as ?<id>, counted as false positives)`,
    );
  }
  return out;
}

function toObserved(
  fixture: RelevanceQuery,
  rows: readonly ObservedRow[],
): ObservedQuery {
  return {
    id: fixture.id,
    q: fixture.q,
    kind: fixture.kind,
    ...(fixture.tags ? { tags: fixture.tags } : {}),
    expect: fixture.expect,
    ...(fixture.acceptable ? { acceptable: fixture.acceptable } : {}),
    rows,
  };
}

// ---- report ----------------------------------------------------------------

const pct = (v: number | null) =>
  v === null ? "   –  " : `${(v * 100).toFixed(1).padStart(5)}%`;
const num = (v: number | null) => (v === null ? "  –  " : v.toFixed(3));

function printCurve(curve: Curve): void {
  const { counts, recommendation: rec } = curve;
  console.log(
    `\nFixtures: ${counts.positives} positives (+${counts.crossLanguage} cross-language, reported only), ` +
      `${counts.negatives} negatives, ${counts.policyFiltered} policy-filtered (must return nothing).\n`,
  );
  console.log(
    "floor  precision  recall   answered  top-3 clean  empty pos  FP rate (neg)  neg rows   TP  FP  miss",
  );
  for (const p of curve.floors) {
    const flag =
      p.negativeRate <= rec.maxNegativeRate && p.recall >= rec.minRecall
        ? " ✓"
        : "";
    console.log(
      `${p.floor.toFixed(2)}   ${pct(p.precision)}    ${pct(p.recall)}  ${pct(p.answeredRate)}   ${String(p.topClean).padStart(5)}/${counts.positives}` +
        `     ${String(p.emptyPositives).padStart(4)}     ${pct(p.negativeRate)} (${String(p.negativeQueriesHit).padStart(2)})   ${String(p.negativeRows).padStart(5)}  ${String(p.truePositives).padStart(4)} ${String(p.falsePositives).padStart(3)} ${String(p.misses).padStart(4)}${flag}`,
    );
  }
  const d = curve.distributions;
  console.log("\nScore distributions (cosine):");
  console.log(
    "                                 n    p10    p50    p90    min    max",
  );
  for (const [label, p] of [
    ["positives: expected reviews   ", d.positiveHits],
    ["positives: unrelated reviews  ", d.positiveFalse],
    ["negatives: best score / query ", d.negativeTop],
    ["negatives: every row          ", d.negativeAll],
  ] as const) {
    console.log(
      `${label} ${String(p.n).padStart(4)}  ${num(p.p10)}  ${num(p.p50)}  ${num(p.p90)}  ${num(p.min)}  ${num(p.max)}`,
    );
  }
  console.log(
    `\nTargets: negatives' FP rate ≤ ${pct(rec.maxNegativeRate).trim()}, positives' recall ≥ ${pct(rec.minRecall).trim()}.`,
  );
  if (rec.recommended !== null) {
    console.log(
      `Recommended floor: ${rec.recommended.toFixed(2)} (lowest floor meeting both).`,
    );
  } else {
    console.log("No floor meets both targets:");
    console.log(
      `  lowest floor with FP rate under the cap: ${rec.lowestSafe === null ? "none in range" : rec.lowestSafe.toFixed(2)}`,
    );
    console.log(
      `  highest floor with recall over the bar:  ${rec.highestRecall === null ? "none in range" : rec.highestRecall.toFixed(2)}`,
    );
  }
  if (rec.chosen !== null && rec.recommended === null) {
    const p = curve.floors.find((point) => point.floor === rec.chosen);
    console.log(
      `Chosen default: ${rec.chosen.toFixed(2)} — the false-positive cap wins (empty beats irrelevant).` +
        (p
          ? ` There: ${p.answered}/${counts.positives} positives answered, ${p.emptyPositives} empty, pooled recall ${pct(p.recall).trim()}.`
          : ""),
    );
  }
}

function printVerdicts(
  queries: readonly ObservedQuery[],
  floor: number,
  label: string,
): void {
  console.log(`\n${label} at ${floor.toFixed(2)}:`);
  const verdicts = verdictsAt(queries, floor);
  const failing = verdicts.filter((v) => !isClean(v));
  if (failing.length === 0) {
    console.log("  every fixture is answered correctly");
  }
  for (const v of failing) console.log(describe(v));
  const clean = verdicts.length - failing.length;
  console.log(`  (${clean} of ${verdicts.length} fixtures clean)`);
}

function describe(v: QueryVerdict): string {
  const parts: string[] = [];
  if (v.missed.length > 0) {
    parts.push(
      `missed ${v.missed.map((m) => `${m.key}${m.similarity === null ? "" : `@${m.similarity.toFixed(3)}`}`).join(" ")}`,
    );
  }
  if (v.falsePositives.length > 0) {
    parts.push(
      `${v.kind === "positive" ? "unrelated" : "returned"} ${v.falsePositives.map((r) => `${r.key}@${r.similarity.toFixed(3)}`).join(" ")}`,
    );
  }
  const tags = v.tags.length > 0 ? ` [${v.tags.join(",")}]` : "";
  return `  ${v.id} ${v.kind}${tags} "${v.q}": ${parts.join("; ")}`;
}

function report(run: SavedRun, at: number | undefined): void {
  const curve = computeCurve(run.queries);
  console.log(
    `Run ${run.generated_at} against ${run.source.api} (${run.source.embedding}; mode=${run.source.mode}, limit=${run.source.limit}, ${run.queries.length} queries).`,
  );
  const lowest = Math.min(
    ...run.queries.flatMap((q) => q.rows.map((r) => r.similarity)),
  );
  if (!Number.isFinite(lowest)) {
    console.log(
      "\nWARNING: no query returned anything — fake embeddings in the corpus, or a wrong key/origin?",
    );
  } else if (lowest >= DEFAULT_CURVE_OPTIONS.from) {
    console.log(
      `\nWARNING: the lowest score returned is ${lowest.toFixed(3)} ≥ ${DEFAULT_CURVE_OPTIONS.from}: the project's floor was probably not lowered, so the low end of the curve is blind.`,
    );
  }
  printCurve(curve);
  const rec = curve.recommendation;
  const floors =
    rec.recommended !== null
      ? [rec.recommended]
      : [rec.lowestSafe, rec.highestRecall].filter(
          (f): f is number => f !== null,
        );
  for (const floor of floors) {
    printVerdicts(run.queries, floor, "Failing fixtures");
  }
  if (at !== undefined && !floors.includes(at)) {
    printVerdicts(run.queries, at, "Failing fixtures");
  }
  const cross = run.queries.filter((q) => q.tags?.includes("cross-language"));
  const probe = floors[0] ?? at;
  if (cross.length > 0 && probe !== undefined) {
    console.log(`\nCross-language (not tuned on) at ${probe.toFixed(2)}:`);
    for (const v of verdictsAt(cross, probe)) {
      console.log(
        isClean(v)
          ? `  ${v.id} "${v.q}": clean (${v.hits.length} hit${v.hits.length === 1 ? "" : "s"})`
          : describe(v),
      );
    }
  }
}

// ---- two-tier ----------------------------------------------------------------

function optionalFloor(name: string, value: string | undefined) {
  if (value === undefined) return {};
  const n = Number(value);
  if (!(n >= 0 && n <= 1)) {
    usage(`--${name.replaceAll("_", "-")} must be in [0, 1]`);
  }
  return { [name]: n };
}

/**
 * `--annotate`: look up every saved row's chunk and record whether it
 * matches the query lexically, with the same expression the hybrid
 * search's full-text branch uses. Exact as long as the corpus was not
 * re-indexed since the run (the script refuses rows whose chunk is gone).
 */
async function annotate(path: string, rule: LexicalRule): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) usage("--annotate needs DATABASE_URL (the database the api reads)");
  const run = JSON.parse(readFileSync(path, "utf8")) as SavedRun;
  const { createDb } = await import("../src/client.js");
  const { db, sql } = createDb(url, { max: 1 });
  let marked = 0;
  let lexical = 0;
  try {
    const queries: SavedRun["queries"][number][] = [];
    for (const query of run.queries) {
      const saved: readonly SavedRow[] = query.rows;
      const ids = saved.map((row) => row.chunk_id);
      if (ids.some((id) => id === undefined)) {
        usage(`${query.id}: rows without chunk_id — collect a new run first`);
      }
      const found = await db.execute<{ id: string; lexical: boolean }>(
        drizzleSql`
          SELECT id, ${lexicalMatchSql(drizzleSql`tsv`, query.q, rule, GENERIC_QUERY_WORDS)} AS lexical
          FROM review_chunks
          WHERE id IN (${drizzleSql.join(
            (ids as string[]).map((id) => drizzleSql`${id}::uuid`),
            drizzleSql`, `,
          )})`,
      );
      const byId = new Map(found.map((row) => [row.id, row.lexical]));
      const rows = saved.map((row): SavedRow => {
        const flag = byId.get(row.chunk_id as string);
        if (flag === undefined) {
          usage(
            `${query.id}: chunk ${row.chunk_id} no longer exists (re-indexed?)`,
          );
        }
        marked++;
        if (flag) lexical++;
        return { ...row, lexical: flag };
      });
      queries.push({ ...query, rows });
    }
    const next: SavedRun = { ...run, queries, summary: computeCurve(queries) };
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `db:tune-floor: annotated ${marked} rows (${lexical} lexical, rule ${rule}) in ${path}`,
    );
  } finally {
    await sql.end();
  }
}

type GridRow = { high: number; low: number } & FloorPoint;

function reportTwoTier(run: SavedRun): void {
  const grid = computeTwoTier(run.queries);
  const flatCurve = computeCurve(run.queries);
  const { annotated } = grid;
  console.log(
    `Run ${run.generated_at} (${run.queries.length} queries); ${annotated.rows}/${annotated.total} rows annotated, ${annotated.lexical} lexical.`,
  );
  if (annotated.rows === 0) {
    console.log(
      "WARNING: no lexical annotations — run --annotate first; the low tier is inert.",
    );
  }
  const positives = flatCurve.counts.positives;
  const header =
    "  high  low   answered        top-3 clean  empty pos  FP rate (neg)   precision  recall";
  const line = (p: GridRow) =>
    `  ${p.high.toFixed(2)}  ${p.low.toFixed(2)}  ${pct(p.answeredRate)} (${String(p.answered).padStart(2)})   ${String(p.topClean).padStart(5)}/${positives}     ${String(p.emptyPositives).padStart(4)}     ${pct(p.negativeRate)} (${String(p.negativeQueriesHit).padStart(2)})    ${pct(p.precision)}   ${pct(p.recall)}`;
  const safeFlat = flatCurve.recommendation.chosen;
  const flatPoint = flatCurve.floors.find((p) => p.floor === safeFlat);
  console.log(
    `\nTwo-tier pairs with the negatives' FP rate ≤ ${pct(grid.maxNegativeRate).trim()}, best first (top 5 of ${grid.ranked.length} safe, ${grid.points.length} searched):`,
  );
  console.log(header);
  for (const p of grid.ranked.slice(0, 5)) console.log(line(p));
  if (flatPoint) {
    console.log("\nFlat baseline (the lowest safe flat floor):");
    console.log(header);
    console.log(
      line({ ...flatPoint, high: flatPoint.floor, low: flatPoint.floor }),
    );
  }
  const best = grid.ranked[0];
  if (best === undefined) {
    console.log("\nNo two-tier pair meets the FP cap.");
    return;
  }
  const passes = twoTier(best.high, best.low);
  console.log(
    `\nFailing fixtures at high ${best.high.toFixed(2)} / low ${best.low.toFixed(2)}:`,
  );
  for (const v of verdictsWith(run.queries, passes).filter(
    (x) => !isClean(x),
  )) {
    console.log(describe(v));
  }
  if (flatPoint) {
    const flatPasses = (row: ObservedRow) => row.similarity >= flatPoint.floor;
    const answers = (q: ObservedQuery, f: (row: ObservedRow) => boolean) =>
      q.rows.some((row) => f(row) && q.expect.includes(row.key));
    const recovered = tunedPositives(run.queries).filter(
      (q) => !answers(q, flatPasses) && answers(q, passes),
    );
    console.log(
      `\nAnswered by the pair but not at flat ${flatPoint.floor.toFixed(2)}: ${recovered.map((q) => `${q.id} "${q.q}"`).join(", ") || "none"}`,
    );
  }
}

// ---- main ------------------------------------------------------------------

async function main(): Promise<void> {
  // parseScriptArgs drops the `--` pnpm forwards (#128, `scripts/args.ts`).
  const { values } = parseScriptArgs({
    options: {
      api: { type: "string" },
      key: { type: "string" },
      origin: { type: "string" },
      limit: { type: "string", default: "20" },
      out: { type: "string" },
      replay: { type: "string" },
      at: { type: "string" },
      "project-floor": { type: "string" },
      "project-lexical-floor": { type: "string" },
      annotate: { type: "string" },
      "two-tier": { type: "boolean", default: false },
      "lexical-rule": { type: "string", default: LEXICAL_RULE },
    },
  });
  const at = values.at === undefined ? undefined : Number(values.at);
  if (at !== undefined && !(at >= 0 && at <= 1))
    usage("--at must be in [0, 1]");

  if (values.annotate !== undefined) {
    const rule = values["lexical-rule"] as LexicalRule;
    if (!LEXICAL_RULES.includes(rule)) {
      usage(`--lexical-rule must be one of ${LEXICAL_RULES.join(", ")}`);
    }
    await annotate(resolve(INVOKED_FROM, values.annotate), rule);
    return;
  }

  if (values.replay !== undefined) {
    if (values.api || values.key || values.origin || values.out) {
      usage("--replay takes no live-mode arguments");
    }
    const run = JSON.parse(
      readFileSync(resolve(INVOKED_FROM, values.replay), "utf8"),
    ) as SavedRun;
    if (run.version !== 1)
      usage(`unsupported run version ${String(run.version)}`);
    if (values["two-tier"]) reportTwoTier(run);
    else report(run, at);
    return;
  }
  if (values["two-tier"]) usage("--two-tier needs --replay <path>");

  if (!values.api) usage("--api is required (or --replay <path>)");
  if (!values.key) usage("--key is required");
  if (!values.key.startsWith("pq_pk_")) {
    usage("--key must be a publishable key (pq_pk_…); never pass a secret key");
  }
  if (!values.origin) usage("--origin is required");
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    usage("--limit must be an integer from 1 to 20");
  }
  const date = new Date().toISOString().slice(0, 10);
  const out =
    values.out === undefined
      ? resolve(REPO_ROOT, "docs/floor-tuning", `${date}.json`)
      : resolve(INVOKED_FROM, values.out);

  console.error(
    `db:tune-floor: ${RELEVANCE_QUERIES.length} queries against ${values.api} (mode=reviews, limit=${limit})`,
  );
  const queries = await observe(values.api, values.key, values.origin, limit);
  const run: SavedRun = {
    version: 1,
    generated_at: new Date().toISOString(),
    source: {
      api: values.api,
      mode: "reviews",
      limit,
      embedding: "@cf/baai/bge-m3 via Workers AI (query and corpus)",
      fixtures: RELEVANCE_QUERIES.length,
      ...optionalFloor("project_floor", values["project-floor"]),
      ...optionalFloor(
        "project_lexical_floor",
        values["project-lexical-floor"],
      ),
    },
    queries,
    summary: computeCurve(queries),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
  console.error(`db:tune-floor: saved ${out}`);
  report(run, at);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(
      `db:tune-floor: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
