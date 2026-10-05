// Onboarding step 3 (#53): indexing. After an import (`?run=<ingestRunId>`)
// this is the import's own `ImportProgress`; after the API path it is one
// meter over the project's live reviews — "Indexing 212 of 340 reviews".
// Either way the page revalidates (2 s, backing off to 30 s and stopping
// after thirty minutes with "Check again", #162) and moves itself on to
// the snippet once every review is indexed. A minute with no reviews at all
// offers the way back. When indexing is deferred (a Places import whose
// send was refused lands with `?indexing=deferred`; otherwise reviews
// unindexed for over two minutes) the page says it is delayed and that the
// user can leave, instead of "usually seconds".
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import {
  ImportProgress,
  type ImportProgressData,
  importSettled,
  Meter,
  PollingStopped,
  useImportPolling,
} from "~/components/import-progress";
import { OnboardingSteps } from "~/components/onboarding/steps";
import { PageHeader } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { FormNotice } from "~/components/ui/field";
import { findProjectRun, getRunProgress, isStarted } from "~/lib/csv.server";
import { withRequestDb } from "~/lib/db.server";
import { importRunPath } from "~/lib/import-paths";
import {
  INDEXING_DEFERRED,
  INDEXING_PARAM,
  indexingHint,
} from "~/lib/indexing";
import {
  type IndexingCounts,
  indexingSettled,
  NO_REVIEWS_HINT_AFTER_MS,
  onboardingPath,
} from "~/lib/onboarding";
import {
  logOnboardingStep,
  onboardingRouteHeaders,
  projectIndexing,
  requireOnboardingProject,
} from "~/lib/onboarding.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app.onboarding.$slug.indexing";

/** How long the finished state shows before the page moves on. */
export const ADVANCE_AFTER_MS = 1_200;

export async function loader(args: Route.LoaderArgs) {
  const { account, project, log, elapsed } =
    await requireOnboardingProject(args);
  const search = new URL(args.request.url).searchParams;
  const runId = search.get("run");
  const deferredByRequest = search.get(INDEXING_PARAM) === INDEXING_DEFERRED;

  const { counts, progress } = await withRequestDb(args.context, async (db) => {
    const counts = await projectIndexing(db, project.id);
    if (!runId) return { counts, progress: null };
    // An unknown or not-yet-started run falls back to the project counts.
    const run = await findProjectRun(db, project.id, runId).catch(() => null);
    if (!run || !isStarted(run)) return { counts, progress: null };
    const p = await getRunProgress(db, run);
    const progress: ImportProgressData = {
      status: run.status,
      received: run.received,
      created: run.created,
      updated: run.updated,
      skipped: run.skipped,
      failed: run.failed,
      processed: p.processed,
      indexed: p.indexed,
      indexing: p.indexing,
      deferred: p.indexing > 0 && (p.deferred || deferredByRequest),
      error: run.error,
    };
    return { counts, progress };
  });

  logOnboardingStep(log, "indexing", {
    elapsed_ms: elapsed,
    account_id: account.id,
    project_id: project.id,
  });
  return {
    project: { name: project.name, slug: project.slug },
    counts,
    progress,
    runHref: runId ? importRunPath(project.slug, runId) : null,
    settled: progress ? importSettled(progress) : indexingSettled(counts),
    snippetHref: onboardingPath("snippet", project.slug),
    reviewsHref: onboardingPath("reviews", project.slug),
  };
}

export const headers = onboardingRouteHeaders;

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `Indexing · ${data.project.name} · ProofQL` : "ProofQL" },
];

export default function OnboardingIndexing({
  loaderData,
}: Route.ComponentProps) {
  const { counts, progress, settled, snippetHref, reviewsHref, runHref } =
    loaderData;
  const navigate = useNavigate();
  const polling = useImportPolling(!settled);
  const quiet = useQuietFor(counts.reviews === 0, NO_REVIEWS_HINT_AFTER_MS);

  // Settled: show the finished state for a beat, then on to the snippet.
  useEffect(() => {
    if (!settled) return;
    const id = setTimeout(() => navigate(snippetHref), ADVANCE_AFTER_MS);
    return () => clearTimeout(id);
  }, [settled, navigate, snippetHref]);

  const failed = progress?.status === "failed";
  const delayed = !settled && (progress?.deferred ?? counts.deferred);

  return (
    <>
      <PageHeader
        overline="Set up · Step 3 of 4"
        title={settled ? "Indexed" : "Indexing"}
        description={
          settled
            ? "Every review is searchable. On to your snippet."
            : delayed
              ? "Your reviews are saved. Each one is split into excerpts and embedded so your pages can ask for the ones that fit."
              : "Each review is split into excerpts and embedded so your pages can ask for the ones that fit. Usually seconds."
        }
      />
      <OnboardingSteps current="indexing" className="mb-8" />

      <div className="flex max-w-2xl flex-col gap-6">
        {progress ? (
          <ImportProgress progress={progress} />
        ) : (
          <IndexingMeter counts={counts} />
        )}

        <PollingStopped polling={polling} />

        {failed && runHref && (
          <FormNotice>
            The import stopped before it finished.{" "}
            <Link to={runHref} className="text-link">
              Open the import
            </Link>{" "}
            for the row-by-row report, or{" "}
            <Link to={reviewsHref} className="text-link">
              add reviews another way
            </Link>
            .
          </FormNotice>
        )}

        {quiet && !failed && (
          <section className="border border-hairline bg-surface-card p-5">
            <FormNotice tone="caution">
              Nothing has arrived yet. If you used the API, run the command and
              it will show up here within seconds; an upload continues from the
              import.
            </FormNotice>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Link
                to={reviewsHref}
                className={cn(
                  buttonVariants({ variant: "secondary", size: "sm" }),
                  "text-ink-900! no-underline! hover:text-ink-900!",
                )}
              >
                Back to add reviews
              </Link>
              <Link
                to={snippetHref}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "text-ink-900! no-underline! hover:text-ink-900!",
                )}
              >
                Skip to the snippet
              </Link>
            </div>
          </section>
        )}

        {delayed && !failed && (
          <Link
            to={snippetHref}
            className={cn(
              buttonVariants({ variant: "secondary", size: "md" }),
              "self-start text-ink-900! no-underline! hover:text-ink-900!",
            )}
          >
            Go on to the snippet
          </Link>
        )}

        {settled && (
          <Link
            to={snippetHref}
            className={cn(
              buttonVariants({ size: "md" }),
              "self-start text-on-dark! no-underline! hover:text-on-dark!",
            )}
          >
            Show my snippet
          </Link>
        )}
      </div>
    </>
  );
}

/** The API-path progress: one meter over the project's live reviews. */
export function IndexingMeter({ counts }: { counts: IndexingCounts }) {
  const done = indexingSettled(counts);
  return (
    <section
      aria-label="Indexing progress"
      aria-live="polite"
      className="border border-hairline bg-surface-card p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-title font-semibold text-ink-900">
          {counts.reviews === 0
            ? "Waiting for reviews"
            : done
              ? `Indexed ${counts.reviews.toLocaleString("en-US")} ${counts.reviews === 1 ? "review" : "reviews"}`
              : `Indexing ${counts.indexed.toLocaleString("en-US")} of ${counts.reviews.toLocaleString("en-US")} reviews`}
        </h2>
        <Badge
          tone={
            counts.reviews === 0 ? "neutral" : done ? "positive" : "caution"
          }
        >
          {counts.reviews === 0
            ? "Waiting"
            : done
              ? "Indexed"
              : counts.deferred
                ? "Delayed"
                : "Indexing"}
        </Badge>
      </div>
      <Meter
        className="mt-5"
        label="Reviews indexed"
        value={counts.indexed}
        total={counts.reviews}
        hint={indexingHint(counts.indexing, counts.deferred)}
      />
    </section>
  );
}

/** True once `condition` has held for `ms` without a break. */
function useQuietFor(condition: boolean, ms: number): boolean {
  const since = useRef<number | null>(null);
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    if (!condition) {
      since.current = null;
      setQuiet(false);
      return;
    }
    since.current ??= Date.now();
    const id = setInterval(() => {
      if (since.current !== null && Date.now() - since.current >= ms) {
        setQuiet(true);
      }
    }, 1_000);
    return () => clearInterval(id);
  }, [condition, ms]);
  return quiet;
}
