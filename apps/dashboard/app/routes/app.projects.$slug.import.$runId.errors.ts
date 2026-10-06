// Resource route (#38): the import's per-row failures as a downloadable
// CSV (`row,reason`), read from R2 beside the upload. 404 when the run had
// none, or belongs to another project; 410 when it had failures but the
// report is gone — the bucket's lifecycle rule deletes upload objects
// UPLOAD_RETENTION_DAYS (7) after they were written (#169).
import { UPLOAD_RETENTION_DAYS } from "@proofql/core";
import { data } from "react-router";

import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { getCloudflare } from "~/lib/context";
import { errorReport, findProjectRun, ImportError } from "~/lib/csv.server";
import { withRequestDb } from "~/lib/db.server";
import type { Route } from "./+types/app.projects.$slug.import.$runId.errors";

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const { env } = getCloudflare(args.context);
  const run = await withRequestDb(args.context, async (db) => {
    const project = await findProjectBySlug(db, account.id, args.params.slug);
    if (!project) throw data(null, { status: 404 });
    return findProjectRun(db, project.id, args.params.runId).catch(
      (error: unknown) => {
        if (error instanceof ImportError)
          throw data(error.message, { status: error.status });
        throw error;
      },
    );
  });
  const report = await errorReport(env.UPLOADS, run);
  if (report.state === "none")
    throw data("This import has no error report.", { status: 404 });
  if (report.state === "expired")
    throw data(
      `This error report has expired. Reports are kept for ${UPLOAD_RETENTION_DAYS} days after an import; import the file again to get a new one.`,
      { status: 410 },
    );
  return new Response(report.csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="import-${run.id.slice(0, 8)}-errors.csv"`,
      "cache-control": "no-store",
    },
  });
}
