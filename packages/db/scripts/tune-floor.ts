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
 *
 * The saved key is never the plaintext of anything: the JSON holds query
 * texts, review keys, and scores only.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  RELEVANCE_QUERIES,
  type RelevanceQuery,
} from "../src/seed/fixtures/relevance.js";
import { DEMO_LIVE_REVIEWS } from "../src/seed/fixtures/reviews.js";
import { parseScriptArgs } from "./args.js";
import {
  type Curve,
  computeCurve,
  DEFAULT_CURVE_OPTIONS,
  isClean,
  type ObservedQuery,
  type ObservedRow,
  type QueryVerdict,
  verdictsAt,
} from "./floor-curve.js";

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
  };
  readonly queries: readonly (ObservedQuery & {
    readonly rows: readonly (ObservedRow & { readonly review_id: string })[];
  })[];
  /** Derived from `queries`; a replay recomputes and ignores it. */
  readonly summary: Curve;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

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
    "floor  precision  recall   FP rate (neg)  neg rows  empty positives  TP  FP  miss",
  );
  for (const p of curve.floors) {
    const flag =
      p.negativeRate <= rec.maxNegativeRate && p.recall >= rec.minRecall
        ? " ✓"
        : "";
    console.log(
      `${p.floor.toFixed(2)}   ${pct(p.precision)}    ${pct(p.recall)}   ${pct(p.negativeRate)} (${String(p.negativeQueriesHit).padStart(2)})` +
        `   ${String(p.negativeRows).padStart(5)}    ${String(p.emptyPositives).padStart(7)}        ${String(p.truePositives).padStart(3)} ${String(p.falsePositives).padStart(3)} ${String(p.misses).padStart(4)}${flag}`,
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
    },
  });
  const at = values.at === undefined ? undefined : Number(values.at);
  if (at !== undefined && !(at >= 0 && at <= 1))
    usage("--at must be in [0, 1]");

  if (values.replay !== undefined) {
    if (values.api || values.key || values.origin || values.out) {
      usage("--replay takes no live-mode arguments");
    }
    const run = JSON.parse(
      readFileSync(resolve(values.replay), "utf8"),
    ) as SavedRun;
    if (run.version !== 1)
      usage(`unsupported run version ${String(run.version)}`);
    report(run, at);
    return;
  }

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
  const out = resolve(
    values.out ?? resolve(REPO_ROOT, "docs/floor-tuning", `${date}.json`),
  );

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
