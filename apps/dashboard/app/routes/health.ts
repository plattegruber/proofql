// Resource route for deploy verification and uptime monitors; the smoke
// steps in .github/workflows/deploy.yml curl it, like the api and pipeline
// workers' /health.
//
// - `/health` touches no bindings on purpose: it answers whether the worker
//   is up, not whether Postgres is, so it can be polled every minute
//   without waking Neon.
// - `/health?deep=1` also runs one uncacheable statement through Hyperdrive
//   (`pingDatabase`, @proofql/db; 5 s timeout) and answers 503 when it
//   fails, logging `health.db_failed` with the cause. Each call wakes a
//   suspended Neon compute for its 5-minute idle window: poll it no more
//   than every 30 minutes (docs/launch.md §16 "Uptime monitoring"). Added
//   after the 2026-10-14 Neon suspension, when onboarding said "Something
//   went wrong" for days behind a green /health.
import type { Logger } from "@proofql/core";
import { type DbPing, pingDatabase } from "@proofql/db";

import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import type { Route } from "./+types/health";

/** The response for a request, given a way to probe the database. */
export async function healthResponse(
  request: Request,
  probe: () => Promise<DbPing>,
  log: Logger,
): Promise<Response> {
  if (new URL(request.url).searchParams.get("deep") !== "1") {
    return Response.json({ ok: true, worker: "dashboard" });
  }
  const ping = await probe();
  const headers = { "cache-control": "no-store" };
  if (ping.ok) {
    return Response.json(
      { ok: true, worker: "dashboard", db: { ok: true, ms: ping.ms } },
      { headers },
    );
  }
  log.log("health.db_failed", {
    level: "error",
    reason: ping.error,
    ms: ping.ms,
    ...(ping.cause === undefined ? {} : { error: ping.cause }),
  });
  return Response.json(
    {
      ok: false,
      worker: "dashboard",
      db: { ok: false, error: ping.error, ms: ping.ms },
    },
    { status: 503, headers },
  );
}

export function loader({ request, context }: Route.LoaderArgs) {
  return healthResponse(
    request,
    () => withRequestDb(context, (db) => pingDatabase(db)),
    getCloudflare(context).log,
  );
}
