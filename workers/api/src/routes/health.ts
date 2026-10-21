/**
 * `GET /health` — two depths:
 *
 * - `/health`: `{ ok: true }` whenever the worker is up. Touches no binding,
 *   so an uptime monitor can poll it every minute without waking Neon.
 * - `/health?deep=1`: also probes Postgres through Hyperdrive
 *   (`pingDatabase`, @proofql/db: one uncacheable `select`, 5 s timeout).
 *   200 `{ ok: true, db: { ok: true, ms } }`, or 503
 *   `{ ok: false, db: { ok: false, error: "timeout" | "failed", ms } }` and
 *   one `health.db_failed` line at error with the cause. Every call reaches
 *   Neon and wakes a suspended compute for its 5-minute idle window, so
 *   poll it no more than every 30 minutes (docs/launch.md §16 "Uptime
 *   monitoring"); the deploy smoke check calls it once per deploy.
 *
 * Added after the 2026-10-14 Neon suspension, when every plain `/health`
 * stayed 200 for days while nothing that needed Postgres worked.
 */

import { pingDatabase } from "@proofql/db";
import { Hono } from "hono";

import type { AppEnv } from "../bindings.js";
import { logFor } from "../request-id.js";

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/", async (c) => {
  if (c.req.query("deep") !== "1") return c.json({ ok: true });
  c.header("cache-control", "no-store");
  const ping = await pingDatabase(c.get("getDb")());
  if (ping.ok) return c.json({ ok: true, db: { ok: true, ms: ping.ms } });
  logFor(c).log("health.db_failed", {
    level: "error",
    reason: ping.error,
    ms: ping.ms,
    ...(ping.cause === undefined ? {} : { error: ping.cause }),
  });
  return c.json(
    { ok: false, db: { ok: false, error: ping.error, ms: ping.ms } },
    503,
  );
});
