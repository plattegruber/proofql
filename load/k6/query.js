/**
 * k6 load test for `GET /v1/query` (#50). One scenario per run, chosen
 * with `-e SCENARIO=<name>`; `load/run.sh` runs them all in sequence.
 *
 *   warm   steady state on one project, every request a KV HIT
 *   cold   miss storm: a never-seen query per request (embed + exact scan)
 *   mixed  80 % warm queries / 20 % unique on one project
 *   multi  20 projects round-robin, 80/20 hit/miss
 *   large  the 50,000-chunk tenant, unique queries (the exact-scan ceiling)
 *
 * Requests go the way the snippet sends them — `GET /v1/query?key=pq_pk_…`
 * with an `Origin` header the project allows — and round-robin across the
 * project's keys so the per-key rate limit (600/min per publishable key on
 * the paid plan the seed uses) is never the thing under test. `-e
 * KEY_KIND=secret` switches to `Authorization: Bearer pq_sk_…`.
 *
 * Inputs (environment variables, all optional):
 *   BASE_URL   default http://localhost:8797 (wrangler dev); point at staging later
 *   KEYS_FILE  default ../.keys.json, written by `pnpm load:seed` (relative to this file)
 *   SCENARIO   default warm
 *   RATE       requests per second (per-scenario default below)
 *   DURATION   e.g. 60s (default 60s)
 *   PROJECT    index into `projects` for the single-project scenarios (default 0)
 *   KEY_KIND   publishable (default) | secret
 *   P95_MS     override the scenario's p95 threshold
 *
 * Thresholds (docs/performance.md): warm p95 < 50 ms, cold p95 < 400 ms,
 * HTTP error rate < 0.1 %, zero 5xx. The latency numbers are the *local*
 * baseline — the fake embedder is ~1 ms and Miniflare's KV is on-disk
 * SQLite. Against staging the miss path adds a Workers AI call and KV adds
 * a network hop, so expect different numbers and read the README.
 */

import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:8797").replace(/\/$/, "");
const SCENARIO = __ENV.SCENARIO || "warm";
const KEY_KIND = __ENV.KEY_KIND || "publishable";
const PROJECT = Number(__ENV.PROJECT || 0);
const DURATION = __ENV.DURATION || "60s";
const LIMIT = 5;

const keys = JSON.parse(open(__ENV.KEYS_FILE || "../.keys.json"));
/** Must match `TOPICS` in scripts/seed-load.ts (the file carries a copy). */
const TOPICS = keys.topics;

const SCENARIOS = {
  warm: { rate: 100, p95: 50, projects: "one", miss: 0 },
  cold: { rate: 50, p95: 400, projects: "one", miss: 1 },
  mixed: { rate: 100, p95: 400, projects: "one", miss: 0.2 },
  multi: { rate: 100, p95: 400, projects: "all", miss: 0.2 },
  large: { rate: 20, p95: 400, projects: "large", miss: 1 },
};

const spec = SCENARIOS[SCENARIO];
if (!spec) {
  throw new Error(
    `unknown SCENARIO ${SCENARIO}; one of ${Object.keys(SCENARIOS).join(", ")}`,
  );
}
const RATE = Number(__ENV.RATE || spec.rate);
const P95 = Number(__ENV.P95_MS || spec.p95);

/** The projects this scenario hits. */
const projects =
  spec.projects === "all"
    ? keys.projects
    : spec.projects === "large"
      ? [keys.large]
      : [keys.projects[PROJECT]];

for (const p of projects) {
  if (!p?.[KEY_KIND] || p[KEY_KIND].length === 0) {
    throw new Error(
      `no ${KEY_KIND} keys for a project in ${__ENV.KEYS_FILE || ".keys.json"}`,
    );
  }
}

const cacheHit = new Rate("cache_hit");
const serverTookMs = new Trend("server_took_ms", true);
const resultsReturned = new Trend("results_returned");
const http5xx = new Counter("http_5xx");
const rateLimited = new Counter("http_429");

export const options = {
  scenarios: {
    [SCENARIO]: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.max(20, Math.ceil(RATE / 2)),
      maxVUs: Math.max(200, RATE * 4),
    },
  },
  thresholds: {
    http_req_duration: [`p(95)<${P95}`],
    http_req_failed: ["rate<0.001"],
    http_5xx: ["count<1"],
    http_429: ["count<1"],
    checks: ["rate>0.999"],
    ...(spec.miss === 0 ? { cache_hit: ["rate>0.99"] } : {}),
    ...(spec.miss === 1 ? { cache_hit: ["rate<0.01"] } : {}),
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

function request(key, q) {
  const params = {
    tags: { name: "query" },
    headers: { Accept: "application/json" },
  };
  let url = `${BASE_URL}/v1/query?q=${encodeURIComponent(q)}&limit=${LIMIT}`;
  if (KEY_KIND === "secret") {
    params.headers.Authorization = `Bearer ${key}`;
  } else {
    params.headers.Origin = keys.origin;
    url += `&key=${encodeURIComponent(key)}`;
  }
  return http.get(url, params);
}

/** A query that is one of the seeded `window` chunks verbatim → a hit after warm-up. */
function warmQuery(i) {
  return TOPICS[i % TOPICS.length];
}

/** A query nobody has sent before → a guaranteed miss, still above the floor. */
function uniqueQuery(i) {
  return `${TOPICS[i % TOPICS.length]} visit ${i}`;
}

export function setup() {
  const health = http.get(`${BASE_URL}/health`);
  if (health.status !== 200) {
    throw new Error(`${BASE_URL}/health returned ${health.status}`);
  }
  // Prime the cache for every (project, warm query) pair the run can send,
  // so a warm scenario measures HITs from its first request. Misses here
  // are expected and not counted against the thresholds (setup is untagged).
  if (spec.miss < 1) {
    for (const p of projects) {
      for (let i = 0; i < TOPICS.length; i++) {
        const res = request(p[KEY_KIND][i % p[KEY_KIND].length], warmQuery(i));
        if (res.status !== 200) {
          throw new Error(
            `warm-up for ${p.slug} failed: ${res.status} ${res.body}`,
          );
        }
      }
    }
  }
  return { startedAt: new Date().toISOString() };
}

export default function () {
  const i = exec.scenario.iterationInTest;
  const project = projects[i % projects.length];
  const keyList = project[KEY_KIND];
  const key = keyList[Math.floor(i / projects.length) % keyList.length];

  // Deterministic 80/20 (or 0/100 %) split: every fifth iteration is a miss.
  const miss =
    spec.miss >= 1
      ? true
      : spec.miss <= 0
        ? false
        : i % Math.round(1 / spec.miss) === 0;
  const q = miss ? uniqueQuery(i) : warmQuery(i);

  const res = request(key, q);

  const outcome = res.headers["X-Cache"] || res.headers["x-cache"] || "";
  cacheHit.add(outcome === "HIT");
  if (res.status >= 500) http5xx.add(1);
  if (res.status === 429) rateLimited.add(1);

  let body = null;
  try {
    body = res.json();
  } catch (_) {
    body = null;
  }
  if (body && typeof body.took_ms === "number") {
    serverTookMs.add(body.took_ms);
    resultsReturned.add(Array.isArray(body.results) ? body.results.length : 0);
  }

  check(res, {
    "status 200": (r) => r.status === 200,
    "has results array": () => body !== null && Array.isArray(body.results),
    "x-cache present": () => outcome !== "",
  });
}

export function teardown(data) {
  // Printed by run.sh alongside the Postgres snapshots; handy for matching
  // `query.completed` log lines to a scenario window.
  console.log(
    `scenario=${SCENARIO} rate=${RATE}/s duration=${DURATION} started=${data.startedAt} finished=${new Date().toISOString()}`,
  );
}
