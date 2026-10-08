// Onboarding step 2 (#53): add your reviews. Only options that work in
// this environment are offered: import the Google Business Profile's
// reviews from a Takeout export (the Takeout page, which returns to step 3
// afterwards), upload an export (the import wizard, which returns here
// afterwards), find the business on Google and pull its five public
// reviews (#47; only where GOOGLE_PLACES_API_KEY is set), connect Google
// (#45; only once GOOGLE_CONNECTOR_ENABLED is on, after Google's approval,
// #44), or push through the API with a ready-to-run curl carrying the live
// secret key from step 1. "Check for reviews" polls the
// project's count until something arrives, then moves on to the indexing
// step. It polls on the shared schedule (app/lib/indexing.ts: every 2 s)
// for one minute per click, so a forgotten tab costs nothing (#162).
import { Code2, FileArchive, MapPin, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import {
  PLACES_CARD_BODY,
  PLACES_CARD_TITLE,
  PlacesFinder,
} from "~/components/import/places-finder";
import { TakeoutSteps } from "~/components/import/takeout-import";
import { useBackoffPolling } from "~/components/import-progress";
import { OnboardingSteps } from "~/components/onboarding/steps";
import { PageHeader } from "~/components/shell/page-header";
import { Button, buttonVariants } from "~/components/ui/button";
import { CopyButton } from "~/components/ui/copy-button";
import { withRequestDb } from "~/lib/db.server";
import { connectorEnabled } from "~/lib/google.server";
import { importPath } from "~/lib/import-paths";
import { scheduleUntil } from "~/lib/indexing";
import {
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
import { takeoutPath } from "~/lib/takeout";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app.onboarding.$slug.reviews";

/** How long "Check for reviews" keeps polling before it gives up quietly. */
export const CHECK_TIMEOUT_MS = 60_000;
const CHECK_SCHEDULE = scheduleUntil(CHECK_TIMEOUT_MS);

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
    takeoutHref: `${takeoutPath(project.slug)}?${ONBOARDING_FLAG}=1`,
    places: {
      enabled: placesConfigured(env),
      actionPath: placesActionPath(project.slug),
    },
    // The connector's card appears only once it is switched on (#44, #45).
    connector: {
      enabled: connectorEnabled(env),
      href: `/app/projects/${project.slug}/integrations`,
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
  const {
    project,
    counts,
    hasSecret,
    curl,
    importHref,
    takeoutHref,
    places,
    connector,
    keysHref,
  } = loaderData;
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

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <OptionCard
          icon={<FileArchive size={18} strokeWidth={1.75} aria-hidden />}
          title="Import your Google reviews"
          body="Every review of your Google Business Profile, from a Takeout export you download yourself. Read in your browser; only the reviews are sent."
          action={
            <div className="flex flex-col gap-4">
              <TakeoutSteps />
              <Link
                to={takeoutHref}
                className={cn(
                  buttonVariants({ size: "md" }),
                  "self-start text-on-dark! no-underline! hover:text-on-dark!",
                )}
              >
                Import from Takeout
              </Link>
            </div>
          }
        />

        <OptionCard
          icon={<Upload size={18} strokeWidth={1.75} aria-hidden />}
          title="Upload a CSV or JSON export"
          body="An export from Yelp, Trustpilot, Birdeye, Podium or any spreadsheet. We detect the columns; you confirm them."
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

        {places.enabled && (
          <OptionCard
            icon={<MapPin size={18} strokeWidth={1.75} aria-hidden />}
            title={PLACES_CARD_TITLE}
            body={PLACES_CARD_BODY}
            action={
              <PlacesFinder actionPath={places.actionPath} enabled onboarding />
            }
          />
        )}

        {connector.enabled && (
          <OptionCard
            icon={<GoogleMark />}
            title="Connect Google"
            body="Reviews from your Google Business Profile, kept in sync automatically: sign in with Google, pick your locations."
            action={
              <Link
                to={connector.href}
                className={cn(
                  buttonVariants({ size: "md" }),
                  "text-on-dark! no-underline! hover:text-on-dark!",
                )}
              >
                Connect Google
              </Link>
            }
          />
        )}

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
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={`option-${title}`}
      className="flex flex-col border border-hairline bg-surface-card p-5"
    >
      <div className="flex size-9 items-center justify-center border border-hairline text-ink-900">
        {icon}
      </div>
      <h2
        id={`option-${title}`}
        className="mt-4 mb-0 text-title font-semibold text-ink-900"
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
  const [asked, setAsked] = useState(false);
  const count = fetcher.data?.reviews ?? initialCount;
  const found = count > 0 && fetcher.data !== undefined;

  // Poll once asked, until reviews arrive or a minute passes.
  const polling = useBackoffPolling(
    asked && !found,
    () => {
      if (fetcher.state === "idle") fetcher.load(statusHref);
    },
    CHECK_SCHEDULE,
  );

  // Something arrived: on to indexing.
  useEffect(() => {
    if (!found) return;
    const id = setTimeout(() => navigate(indexingHref), 900);
    return () => clearTimeout(id);
  }, [found, navigate, indexingHref]);

  const checking = asked && !found && !polling.stopped;
  const timedOut = polling.stopped && fetcher.data !== undefined && !found;

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
            if (asked) {
              polling.checkAgain();
            } else {
              setAsked(true);
              fetcher.load(statusHref);
            }
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
