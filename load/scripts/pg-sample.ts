/**
 * Postgres connection sampler for a load run (#108): polls
 * `pg_stat_activity` every `--interval` ms (default 500) and prints the
 * peak number of client backends seen, grouped by `usename@application`,
 * so a run against a database without `psql` (the Neon preview branch, via
 * its *direct* endpoint, not the pooler) still gets a connection peak.
 *
 *   DATABASE_URL=… pnpm --filter @proofql/db exec tsx ../../load/scripts/pg-sample.ts --once
 *   DATABASE_URL=… pnpm --filter @proofql/db exec tsx ../../load/scripts/pg-sample.ts --seconds 90
 *   (or start it with a long `--seconds` and `kill -TERM` it when k6 exits;
 *   the summary is still printed)
 *
 * Output per sample (stderr, one line) and a summary (stdout) at the end:
 * peak backends, peak per state, `pg_stat_database.sessions` and
 * `xact_commit` deltas over the window. The sampler itself is one backend
 * and is excluded from the counts (`pid <> pg_backend_pid()`).
 */

import postgres from "postgres";

function flag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  if (!Number.isFinite(n)) throw new Error(`--${name} needs a number`);
  return n;
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const once = process.argv.includes("--once");
const seconds = flag("seconds", 60);
const interval = flag("interval", 500);

const sql = postgres(url, { max: 1, prepare: false });

interface Snapshot {
  total: number;
  active: number;
  idle: number;
  idleInTx: number;
  sessions: number;
  xactCommit: number;
  maxConnections: number;
}

async function snapshot(): Promise<Snapshot> {
  const [row] = await sql<
    {
      total: number;
      active: number;
      idle: number;
      idle_in_tx: number;
      sessions: number;
      xact_commit: number;
      max_connections: number;
    }[]
  >`
    select
      (select count(*) from pg_stat_activity
        where backend_type = 'client backend' and pid <> pg_backend_pid())::int as total,
      (select count(*) from pg_stat_activity
        where backend_type = 'client backend' and pid <> pg_backend_pid() and state = 'active')::int as active,
      (select count(*) from pg_stat_activity
        where backend_type = 'client backend' and pid <> pg_backend_pid() and state = 'idle')::int as idle,
      (select count(*) from pg_stat_activity
        where backend_type = 'client backend' and pid <> pg_backend_pid() and state like 'idle in transaction%')::int as idle_in_tx,
      (select sessions from pg_stat_database where datname = current_database())::int as sessions,
      (select xact_commit from pg_stat_database where datname = current_database())::int as xact_commit,
      current_setting('max_connections')::int as max_connections
  `;
  if (!row) throw new Error("no row");
  return {
    total: row.total,
    active: row.active,
    idle: row.idle,
    idleInTx: row.idle_in_tx,
    sessions: row.sessions,
    xactCommit: row.xact_commit,
    maxConnections: row.max_connections,
  };
}

async function main(): Promise<void> {
  const first = await snapshot();
  if (once) {
    console.log(JSON.stringify(first));
    return;
  }
  const peak = { total: 0, active: 0, idle: 0, idleInTx: 0 };
  const deadline = Date.now() + seconds * 1000;
  // SIGTERM/SIGINT end the window early and still print the summary, so a
  // runner can start the sampler, run k6, then `kill -TERM` it.
  let stopped = false;
  process.once("SIGTERM", () => {
    stopped = true;
  });
  process.once("SIGINT", () => {
    stopped = true;
  });
  let last = first;
  let samples = 0;
  while (!stopped && Date.now() < deadline) {
    const s = await snapshot();
    samples++;
    last = s;
    peak.total = Math.max(peak.total, s.total);
    peak.active = Math.max(peak.active, s.active);
    peak.idle = Math.max(peak.idle, s.idle);
    peak.idleInTx = Math.max(peak.idleInTx, s.idleInTx);
    process.stderr.write(
      `${new Date().toISOString()} backends=${s.total} active=${s.active} idle=${s.idle} idle_in_tx=${s.idleInTx}\n`,
    );
    await new Promise((r) => setTimeout(r, interval));
  }
  if (stopped) last = await snapshot();
  console.log(
    JSON.stringify({
      seconds,
      samples,
      max_connections: first.maxConnections,
      peak,
      sessions_opened: last.sessions - first.sessions,
      xact_committed: last.xactCommit - first.xactCommit,
    }),
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
