// Onboarding step 2 (#53): add your reviews. Four equal cards — upload an
// export (the import wizard, which returns here afterwards), find the
// business on Google and pull its five public reviews (#47; enabled where
// GOOGLE_PLACES_API_KEY is set), connect Google (not yet; waiting on
// Google's API approval), or push through the API with a ready-to-run curl
// carrying the live secret key from step 1. "Check for reviews" polls the
// project's count until something arrives, then moves on to the indexing
// step.
import { Code2, MapPin, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";

import {
  PLACES_CARD_BODY,
  PLACES_CARD_TITLE,
  PlacesFinder,
} from "~/components/import/places-finder";
import { OnboardingSteps } from "~/components/onboarding/steps";
import { PageHeader } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { CopyButton } from "~/components/ui/copy-button";
import { withRequestDb } from "~/lib/db.server";
import { importPath } from "~/lib/import-paths";
import {
  INDEXING_POLL_MS,
  type IndexingCounts,
  ingestCurl,
  ONBOARDING_FLAG,
  onboardingPath,
  onboardingResourcePath,
} from "~/lib/onboarding";
import {
  logOnboardingStep,
  onboardingRouteHeaders,
  projectIndexing,
  requireOnboardingProject,
  sessionKeysFor,
} from "~/lib/onboarding.server";
import { placesActionPath } from "~/lib/places";
import { placesConfigured } from "~/lib/places.server";
import { secretKeyPlaceholder } from "~/lib/playground";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app.onboarding.$slug.reviews";

/** Google Business Profile API access (#44). Linked, not named, on the card. */
const GOOGLE_CONNECTOR_ISSUE_URL =
  "https://github.com/plattegruber/proofql/issues/44";

/** How long "Check for reviews" keeps polling before it gives up quietly. */
export const CHECK_TIMEOUT_MS = 60_000;

export async function loader(args: Route.LoaderArgs) {
  const { account, project, env, log, session, elapsed } =
    await requireOnboardingProject(args);
  const counts = await withRequestDb(args.context, (db) =>
    projectIndexing(db, project.id),
  );
  const { secret } = sessionKeysFor(session, project.id);
  logOnboardingStep(log, "reviews", {
    elapsed_ms: elapsed,
    account_id: account.id,
    project_id: project.id,
  });
  return {
    project: { name: project.name, slug: project.slug },
    counts,
    hasSecret: secret !== null,
    curl: ingestCurl({
      apiUrl: env.API_URL,
      secretKey: secret ?? secretKeyPlaceholder("live"),
    }),
    importHref: `${importPath(project.slug)}?${ONBOARDING_FLAG}=1`,
    places: {
      enabled: placesConfigured(env),
      actionPath: placesActionPath(project.slug),
    },
    keysHref: `/app/projects/${project.slug}/keys`,
    indexingHref: onboardingPath("indexing", project.slug),
    statusHref: onboardingResourcePath("status", project.slug),
  };
}

export const headers = onboardingRouteHeaders;

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `Add reviews · ${data.project.name} · ProofQL` : "ProofQL" },
];

export default function OnboardingReviews({
  loaderData,
}: Route.ComponentProps) {
  const { project, counts, hasSecret, curl, importHref, places, keysHref } =
    loaderData;
  return (
    <>
      <PageHeader
        overline="Set up · Step 2 of 4"
        title="Add your reviews"
        description={`Pick one way to get reviews into ${project.name}. You can add more later from the project's Import tab or the API.`}
      />
      <OnboardingSteps current="reviews" className="mb-8" />

      {counts.reviews > 0 && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-ink-900 bg-surface-sunken px-4 py-3">
          <p className="m-0 text-small text-ink-900">
            <span className="font-mono tabular-nums">
              {counts.reviews.toLocaleString("en-US")}
            </span>{" "}
            {counts.reviews === 1 ? "review is" : "reviews are"} already in this
            project.
          </p>
          <Link
            to={loaderData.indexingHref}
            className={cn(
              buttonVariants({ size: "sm" }),
              "text-on-dark! no-underline! hover:text-on-dark!",
            )}
          >
            Continue to indexing
          </Link>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <OptionCard
          icon={<Upload size={18} strokeWidth={1.75} aria-hidden />}
          title="Upload a CSV or JSON export"
          body="An export from Google, Yelp, Trustpilot, Birdeye, Podium or any spreadsheet. We detect the columns; you confirm them."
          action={
            <Link
              to={importHref}
              className={cn(
                buttonVariants({ size: "md" }),
                "text-on-dark! no-underline! hover:text-on-dark!",
              )}
            >
              Upload a file
            </Link>
          }
        />

        <OptionCard
          disabled={!places.enabled}
          icon={<MapPin size={18} strokeWidth={1.75} aria-hidden />}
          title={PLACES_CARD_TITLE}
          body={PLACES_CARD_BODY}
          action={
            <PlacesFinder
              actionPath={places.actionPath}
              enabled={places.enabled}
              onboarding
            />
          }
        />

        <OptionCard
          disabled
          icon={<GoogleMark />}
          title="Connect Google"
          body="Reviews from your Google Business Profile, kept in sync automatically."
          action={
            <>
              <Badge tone="caution">Coming soon</Badge>
              <p className="m-0 mt-2 text-small text-gray-600">
                We are waiting on Google's API approval.{" "}
                <a
                  href={GOOGLE_CONNECTOR_ISSUE_URL}
                  className="text-link"
                  rel="noopener"
                  target="_blank"
                >
                  Follow along
                </a>
                .
              </p>
            </>
          }
        />

        <OptionCard
          icon={<Code2 size={18} strokeWidth={1.75} aria-hidden />}
          title="Use the API"
          body="Push reviews from your own system. This sends three sample reviews with your live secret key; replace them with yours."
          action={
            <ApiPath
              curl={curl}
              hasSecret={hasSecret}
              keysHref={keysHref}
              statusHref={loaderData.statusHref}
              indexingHref={loaderData.indexingHref}
              initialCount={counts.reviews}
            />
          }
        />
      </div>
    </>
  );
}

function OptionCard({
  icon,
  title,
  body,
  action,
  disabled = false,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <section
      aria-labelledby={`option-${title}`}
      aria-disabled={disabled || undefined}
      className={cn(
        "flex flex-col border border-hairline bg-surface-card p-5",
        disabled && "bg-surface-sunken",
      )}
    >
      <div
        className={cn(
          "flex size-9 items-center justify-center border border-hairline",
          disabled ? "text-gray-400" : "text-ink-900",
        )}
      >
        {icon}
      </div>
      <h2
        id={`option-${title}`}
        className={cn(
          "mt-4 mb-0 text-title font-semibold",
          disabled ? "text-gray-500" : "text-ink-900",
        )}
      >
        {title}
      </h2>
      <p className="mt-2 mb-0 flex-1 text-small text-gray-600">{body}</p>
      <div className="mt-5 border-t border-hairline pt-4">{action}</div>
    </section>
  );
}

/** A plain "G" in the house mono — no brand asset, by design. */
function GoogleMark() {
  return (
    <span className="font-mono text-data font-semibold" aria-hidden>
      G
    </span>
  );
}

function ApiPath({
  curl,
  hasSecret,
  keysHref,
  statusHref,
  indexingHref,
  initialCount,
}: {
  curl: string;
  hasSecret: boolean;
  keysHref: string;
  statusHref: string;
  indexingHref: string;
  initialCount: number;
}) {
  const fetcher = useFetcher<IndexingCounts>();
  const navigate = useNavigate();
  const [checkingSince, setCheckingSince] = useState<number | null>(null);
  const count = fetcher.data?.reviews ?? initialCount;
  const found = count > 0 && fetcher.data !== undefined;

  // Poll every two seconds once asked, until reviews arrive or a minute passes.
  useEffect(() => {
    if (checkingSince === null || found) return;
    const id = setInterval(() => {
      if (Date.now() - checkingSince > CHECK_TIMEOUT_MS) {
        setCheckingSince(null);
        return;
      }
      if (fetcher.state === "idle") fetcher.load(statusHref);
    }, INDEXING_POLL_MS);
    return () => clearInterval(id);
  }, [checkingSince, found, fetcher, statusHref]);

  // Something arrived: on to indexing.
  useEffect(() => {
    if (!found) return;
    const id = setTimeout(() => navigate(indexingHref), 900);
    return () => clearTimeout(id);
  }, [found, navigate, indexingHref]);

  const checking = checkingSince !== null && !found;
  const timedOut =
    checkingSince === null && fetcher.data !== undefined && !found;

  return (
    <div className="flex flex-col gap-3">
      <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-all bg-surface-sunken p-3 font-mono text-2xs leading-relaxed text-ink-900">
        <code>{curl}</code>
      </pre>
      {!hasSecret && (
        <p className="m-0 text-small text-gray-600">
          The secret key from step 1 was shown for one hour and is not stored.{" "}
          <Link to={keysHref} className="text-link">
            Create a new one in Keys
          </Link>{" "}
          and paste it in place of the placeholder.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton value={curl} label="Command copied" size="sm">
          Copy command
        </CopyButton>
        <Button
          variant="secondary"
          size="sm"
          disabled={checking}
          onClick={() => {
            setCheckingSince(Date.now());
            fetcher.load(statusHref);
          }}
        >
          {checking ? "Checking…" : "Check for reviews"}
        </Button>
      </div>
      <p className="m-0 min-h-5 text-small text-gray-600" aria-live="polite">
        {found
          ? `${count.toLocaleString("en-US")} ${count === 1 ? "review" : "reviews"} received. Moving on to indexing.`
          : checking
            ? "Waiting for reviews to arrive. Run the command in a terminal."
            : timedOut
              ? "Nothing yet. Run the command, then check again."
              : null}
      </p>
    </div>
  );
}
