// Import steps 3 and 4 (#38): the run page polls the `ingest_runs` counts
// and the indexed count (backing off from every two seconds, #162) until
// the run has finished and the pipeline has caught up, then shows the
// result with the error report and a way into the Reviews tab. The polling
// view is `ImportProgress`, shared with the onboarding (#53). When indexing
// is deferred (`?indexing=deferred` from a Places import whose send was
// refused, or reviews unindexed for over two minutes) it says so instead of
// "searchable within seconds".
import { UPLOAD_RETENTION_DAYS } from "@proofql/core";
import { useEffect, useRef, useState } from "react";
import { data, Form, Link, redirect } from "react-router";

import {
  ImportProgress,
  type ImportProgressData,
  importSettled,
  PollingStopped,
  useImportPolling,
} from "~/components/import-progress";
import { PageHeader } from "~/components/shell/page-header";
import { Button, buttonVariants } from "~/components/ui/button";
import { FormNotice } from "~/components/ui/field";
import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { runImportInBackground } from "~/lib/background.server";
import {
  errorReportExpired,
  findProjectRun,
  getRunProgress,
  ImportError,
  isStarted,
} from "~/lib/csv.server";
import { withRequestDb } from "~/lib/db.server";
import {
  importErrorsPath,
  importMapPath,
  importPath,
} from "~/lib/import-paths";
import { INDEXING_DEFERRED, INDEXING_PARAM } from "~/lib/indexing";
import { takeoutPath } from "~/lib/takeout";
import { type TakeoutRunDetails, takeoutDetails } from "~/lib/takeout.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app.projects.$slug.import.$runId";

/** A running import with no count change for this long offers "Resume". */
export const STALL_AFTER_MS = 20_000;

async function loadRun(args: Route.LoaderArgs | Route.ActionArgs) {
  const { account } = await requireAccount(args);
  return withRequestDb(args.context, async (db) => {
    const project = await findProjectBySlug(db, account.id, args.params.slug);
    if (!project) throw data(null, { status: 404 });
    const run = await findProjectRun(db, project.id, args.params.runId).catch(
      (error: unknown) => {
        if (error instanceof ImportError)
          throw data(error.message, { status: error.status });
        throw error;
      },
    );
    return { project, run, progress: await getRunProgress(db, run) };
  });
}

export async function loader(args: Route.LoaderArgs) {
  const { project, run, progress } = await loadRun(args);
  if (!isStarted(run)) throw redirect(importMapPath(project.slug, run.id));
  const deferredByRequest =
    new URL(args.request.url).searchParams.get(INDEXING_PARAM) ===
    INDEXING_DEFERRED;
  const view: ImportProgressData = {
    status: run.status,
    received: run.received,
    created: run.created,
    updated: run.updated,
    skipped: run.skipped,
    failed: run.failed,
    processed: progress.processed,
    indexed: progress.indexed,
    indexing: progress.indexing,
    deferred: progress.indexing > 0 && (progress.deferred || deferredByRequest),
    error: run.error,
  };
  return {
    project: { slug: project.slug, name: project.name },
    run: {
      id: run.id,
      // `places` runs (#47) phrase the result differently and have no report.
      kind: run.kind,
      environment: run.environment,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      // Upload objects expire after UPLOAD_RETENTION_DAYS (#169).
      reportExpired: errorReportExpired(run),
      // Takeout runs: removed / replaced / star-only / stale (takeout.server.ts).
      takeout: run.kind === "takeout" ? takeoutDetails(run) : null,
    },
    progress: view,
  };
}

/** `intent=resume`: pick a stalled run back up (uploads and Takeout; a Places run has no file). */
export async function action(args: Route.ActionArgs) {
  const { project, run } = await loadRun(args);
  if (
    (run.kind === "csv" || run.kind === "takeout") &&
    run.status === "running" &&
    isStarted(run)
  ) {
    runImportInBackground(args.context, run.id, run.kind);
  }
  return redirect(`${importPath(project.slug)}/${run.id}`);
}

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `Import · ${data.project.name} · ProofQL` : "ProofQL" },
];

export default function ImportRun({ loaderData }: Route.ComponentProps) {
  const { project, run, progress } = loaderData;
  const settled = importSettled(progress);
  const polling = useImportPolling(!settled);
  const stalled = useStallDetector(
    progress.status === "running",
    progress.processed,
  );
  const reviewsPath = `/app/projects/${project.slug}/reviews`;

  return (
    <>
      <PageHeader
        overline={settled ? "Done" : "Step 3 of 3"}
        title={settled ? "Import finished" : "Importing"}
        description={
          settled
            ? `Finished ${run.finishedAt ? new Date(run.finishedAt).toLocaleString("en-US") : ""} into the ${run.environment} environment.`
            : "You can leave this page; the import keeps going."
        }
      />
      <div className="max-w-2xl flex flex-col gap-6">
        <ImportProgress progress={progress} />
        <PollingStopped polling={polling} />

        {stalled && (
          <Form
            method="post"
            className="flex items-center justify-between gap-3 border border-hairline bg-surface-card p-5"
          >
            <FormNotice tone="caution">
              Nothing has moved for a while. Resuming continues from the last
              row that was counted; nothing is imported twice.
            </FormNotice>
            <Button
              type="submit"
              name="intent"
              value="resume"
              variant="secondary"
            >
              Resume
            </Button>
          </Form>
        )}

        {progress.status !== "running" && (
          <section
            aria-labelledby="result-heading"
            className="border border-hairline bg-surface-card p-5"
          >
            <h2
              id="result-heading"
              className="m-0 text-title font-semibold text-ink-900"
            >
              {progress.status === "failed"
                ? "The import stopped"
                : "What happened"}
            </h2>
            <p className="mt-2 mb-0 text-small text-gray-600">
              {run.kind === "takeout" ? (
                <TakeoutResult progress={progress} details={run.takeout} />
              ) : run.kind === "places" ? (
                <>
                  {progress.created.toLocaleString("en-US")} reviews created,{" "}
                  {progress.updated.toLocaleString("en-US")} updated,{" "}
                  {progress.skipped.toLocaleString("en-US")} skipped (a star
                  rating with no text) and{" "}
                  {progress.failed.toLocaleString("en-US")} not imported
                  {progress.failed > 0 && progress.error
                    ? ` — ${progress.error}`
                    : "."}
                </>
              ) : (
                <>
                  {progress.created.toLocaleString("en-US")} reviews created,{" "}
                  {progress.updated.toLocaleString("en-US")} updated,{" "}
                  {progress.skipped.toLocaleString("en-US")} skipped as
                  duplicates and {progress.failed.toLocaleString("en-US")} rows
                  not imported
                  {progress.failed > 0
                    ? ` — the report says why, row by row. It is available for ${UPLOAD_RETENTION_DAYS} days.`
                    : "."}
                </>
              )}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-hairline pt-5">
              <Link
                to={reviewsPath}
                className={cn(buttonVariants({ size: "md" }), "no-underline")}
              >
                Open reviews
              </Link>
              {progress.failed > 0 &&
                (run.kind === "csv" || run.kind === "takeout") &&
                (run.reportExpired ? (
                  <span className="text-small text-gray-600">
                    The error report has expired (kept {UPLOAD_RETENTION_DAYS}{" "}
                    days).
                  </span>
                ) : (
                  <a
                    href={importErrorsPath(project.slug, run.id)}
                    download={`import-${run.id.slice(0, 8)}-errors.csv`}
                    className={cn(
                      buttonVariants({ variant: "secondary", size: "md" }),
                      "no-underline",
                    )}
                  >
                    Download error report
                  </a>
                ))}
              <Link
                to={
                  run.kind === "takeout"
                    ? takeoutPath(project.slug)
                    : importPath(project.slug)
                }
                className={cn(
                  buttonVariants({ variant: "ghost", size: "md" }),
                  "no-underline",
                )}
              >
                {run.kind === "places"
                  ? "Back to Import"
                  : run.kind === "takeout"
                    ? "Import a newer export"
                    : "Import another file"}
              </Link>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

/** True once `processed` has not changed for STALL_AFTER_MS while running. */
function useStallDetector(running: boolean, processed: number): boolean {
  const lastChange = useRef({ processed, at: Date.now() });
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (lastChange.current.processed !== processed) {
      lastChange.current = { processed, at: Date.now() };
      setStalled(false);
    }
    if (!running) {
      setStalled(false);
      return;
    }
    const id = setInterval(() => {
      setStalled(Date.now() - lastChange.current.at > STALL_AFTER_MS);
    }, 1_000);
    return () => clearInterval(id);
  }, [running, processed]);
  return stalled;
}

/** What a Takeout import did, in a sentence per outcome. */
function TakeoutResult({
  progress,
  details,
}: {
  progress: ImportProgressData;
  details: TakeoutRunDetails | null;
}) {
  const n = (value: number) => value.toLocaleString("en-US");
  const starOnly = details?.star_only ?? 0;
  const stale = details?.stale ?? Math.max(0, progress.skipped - starOnly);
  const parts = [
    `${n(progress.created)} ${progress.created === 1 ? "review" : "reviews"} created`,
    `${n(progress.updated)} updated`,
    ...(starOnly > 0
      ? [`${n(starOnly)} star-only skipped (no text to search)`]
      : []),
    ...(stale > 0
      ? [`${n(stale)} left alone because this project already has a newer edit`]
      : []),
  ];
  return (
    <>
      {parts.join(", ")}
      {progress.failed > 0
        ? `, and ${n(progress.failed)} not imported — the report says why. It is available for ${UPLOAD_RETENTION_DAYS} days.`
        : "."}
      {details && (details.removed ?? 0) > 0 && (
        <>
          {" "}
          {n(details.removed ?? 0)}{" "}
          {details.removed === 1 ? "review was" : "reviews were"} removed
          because Google no longer has {details.removed === 1 ? "it" : "them"}.
        </>
      )}
      {details && (details.places_removed ?? 0) > 0 && (
        <>
          {" "}
          The {n(details.places_removed ?? 0)} Google Places{" "}
          {details.places_removed === 1 ? "review was" : "reviews were"}{" "}
          replaced and will no longer refresh.
        </>
      )}
      {details && !details.complete && (
        <>
          {" "}
          Nothing was removed: loose files may be a subset, so import the whole
          .zip to also remove reviews deleted on Google.
        </>
      )}
    </>
  );
}
