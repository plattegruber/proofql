// "Find your business on Google" (#47): a search box, up to five matching
// places, and "Import reviews" on one of them. Shared by onboarding step 2
// and the project's Import tab; both post to the places resource route
// (routes/app.projects.$slug.places.ts), which redirects to the progress
// view once the import has run. Two fetchers so the list stays put while
// an import is in flight.
import { Link, useFetcher } from "react-router";

import { SubmitButton } from "~/components/form/submit-button";
import { Badge } from "~/components/ui/badge";
import { FormNotice, Input } from "~/components/ui/field";
import { ONBOARDING_FLAG } from "~/lib/onboarding";
import { PLACES_REVIEWS_PER_PLACE, type PlaceMatch } from "~/lib/places";
import type { PlacesActionData } from "~/routes/app.projects.$slug.places";

export const PLACES_CARD_TITLE = "Find your business on Google";
export const PLACES_CARD_BODY = `Google shares a business's ${PLACES_REVIEWS_PER_PLACE === 5 ? "five" : PLACES_REVIEWS_PER_PLACE} most relevant public reviews through its Places API; connect your Google Business Profile later for all of them.`;
export const PLACES_ATTRIBUTION_NOTE =
  "Imported reviews keep their author and the Google badge, as Google's terms require.";
export const PLACES_NOT_CONFIGURED_COPY =
  "Not configured in this environment. The owner adds the Places API key for the dashboard; until then, upload an export or use the API.";

/** Google Business Profile API access (#44). Linked, not named, in the copy. */
export const GOOGLE_CONNECTOR_ISSUE_URL =
  "https://github.com/plattegruber/proofql/issues/44";

export interface PlacesFinderProps {
  /** `placesActionPath(slug)`. */
  actionPath: string;
  /** False ⇒ the not-configured copy and nothing else. */
  enabled: boolean;
  /** From the guided onboarding: the import redirects to its step 3. */
  onboarding?: boolean;
  /** Offer live/test (the Import tab); the onboarding imports live. */
  chooseEnvironment?: boolean;
  /** Where "connect your Google Business Profile later" points. */
  connectorHref?: string;
}

export function PlacesFinder({
  actionPath,
  enabled,
  onboarding = false,
  chooseEnvironment = false,
  connectorHref = GOOGLE_CONNECTOR_ISSUE_URL,
}: PlacesFinderProps) {
  const search = useFetcher<PlacesActionData>();
  const run = useFetcher<PlacesActionData>();

  if (!enabled) {
    return (
      <div className="flex flex-col gap-2">
        <Badge tone="neutral">Not configured</Badge>
        <p className="m-0 text-small text-gray-600">
          {PLACES_NOT_CONFIGURED_COPY}
        </p>
      </div>
    );
  }

  const results = search.data && "matches" in search.data ? search.data : null;
  const searchError =
    search.data && "error" in search.data && search.state === "idle"
      ? search.data.error
      : null;
  const importError =
    run.data && "error" in run.data && run.state === "idle"
      ? run.data.error
      : null;
  const importingId =
    run.state !== "idle" ? String(run.formData?.get("place_id") ?? "") : null;

  return (
    <div className="flex flex-col gap-3">
      <search.Form
        method="post"
        action={actionPath}
        className="flex gap-2"
        aria-label="Search Google for your business"
      >
        <input type="hidden" name="intent" value="search" />
        <Input
          name="q"
          type="search"
          required
          minLength={3}
          maxLength={200}
          placeholder="Business name and city"
          aria-label="Business name and city"
          autoComplete="off"
          defaultValue={results?.query}
        />
        <SubmitButton
          fetcher={search}
          size="md"
          variant="secondary"
          pendingLabel="Searching…"
          className="shrink-0"
        >
          Search
        </SubmitButton>
      </search.Form>

      {searchError && <FormNotice>{searchError}</FormNotice>}

      {results && (
        <ol
          aria-label="Matching places"
          className="m-0 flex list-none flex-col divide-y divide-hairline border border-hairline p-0"
        >
          {results.matches.length === 0 && (
            <li className="p-3 text-small text-gray-600">
              Nothing on Google matches "{results.query}". Try the name with the
              city, or the street.
            </li>
          )}
          {results.matches.map((place) => (
            <li
              key={place.id}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-small font-medium text-ink-900">
                  {place.name}
                </p>
                <p className="m-0 truncate text-small text-gray-600">
                  {place.address ?? "Address not shared"}
                </p>
                <p className="m-0 font-mono text-2xs text-gray-500">
                  <PlaceStats place={place} />
                </p>
              </div>
              <run.Form method="post" action={actionPath}>
                <input type="hidden" name="intent" value="import" />
                <input type="hidden" name="place_id" value={place.id} />
                {onboarding && (
                  <input type="hidden" name={ONBOARDING_FLAG} value="1" />
                )}
                {chooseEnvironment ? (
                  <EnvironmentChoice />
                ) : (
                  <input type="hidden" name="environment" value="live" />
                )}
                <SubmitButton
                  fetcher={importingId === place.id ? run : undefined}
                  size="sm"
                  pendingLabel="Importing…"
                  disabled={importingId !== null && importingId !== place.id}
                  aria-label={`Import reviews from ${place.name}`}
                >
                  Import reviews
                </SubmitButton>
              </run.Form>
            </li>
          ))}
        </ol>
      )}

      {importError && <FormNotice>{importError}</FormNotice>}

      <p className="m-0 text-small text-gray-600">
        {PLACES_ATTRIBUTION_NOTE}{" "}
        <Link
          to={connectorHref}
          className="text-link"
          rel="noopener"
          target="_blank"
        >
          The full connector
        </Link>{" "}
        is waiting on Google's API approval.
      </p>
    </div>
  );
}

function PlaceStats({ place }: { place: PlaceMatch }) {
  if (place.ratingCount === null && place.rating === null) {
    return <>No rating yet</>;
  }
  const count = place.ratingCount ?? 0;
  return (
    <>
      {place.rating !== null && `${place.rating.toFixed(1)} ★ · `}
      {count.toLocaleString("en-US")} {count === 1 ? "rating" : "ratings"} on
      Google · up to {PLACES_REVIEWS_PER_PLACE} reviews shared
    </>
  );
}

function EnvironmentChoice() {
  return (
    <span className="mb-2 flex gap-3 text-small text-ink-900">
      <label className="inline-flex items-center gap-1.5">
        <input type="radio" name="environment" value="live" defaultChecked />
        Live
      </label>
      <label className="inline-flex items-center gap-1.5">
        <input type="radio" name="environment" value="test" />
        Test
      </label>
    </span>
  );
}
