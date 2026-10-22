// The Google Takeout picker: choose the archive(s), see what is in them,
// pick the locations that belong to this project, confirm. The archive is
// opened in the browser (app/lib/takeout-reader.ts) and only the chosen
// locations' reviews are posted, as one `TakeoutPayload` JSON blob, to the
// route's action. Shared by the Import tab's Takeout page and, through
// it, the onboarding.
import { buildTakeoutPayload, type TakeoutLocation } from "@proofql/core";
import { FileArchive } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useFetcher } from "react-router";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { FormNotice, Help } from "~/components/ui/field";
import { formatBytes } from "~/lib/import-labels";
import { ONBOARDING_FLAG } from "~/lib/onboarding";
import {
  DAILY_INDEXING_CAPACITY,
  indexingDaysEstimate,
  TAKEOUT_STEPS,
  TAKEOUT_URL,
} from "~/lib/takeout";
import {
  type ReadProgress,
  readTakeoutSelection,
  TakeoutReadError,
  type TakeoutReadResult,
} from "~/lib/takeout-reader";

export interface PlacesBootstrapView {
  environment: "live" | "test";
  reviews: number;
  places: string[];
}

type ReadState =
  | { state: "idle" }
  | { state: "reading"; progress: ReadProgress | null }
  | { state: "error"; message: string }
  | { state: "ready"; result: TakeoutReadResult };

export function TakeoutSteps({ className }: { className?: string }) {
  return (
    <ol
      className={`m-0 flex list-none flex-col gap-2.5 p-0 ${className ?? ""}`}
    >
      {TAKEOUT_STEPS.map((step, i) => (
        <li key={step.label} className="flex gap-3 text-small">
          <span className="flex size-5 shrink-0 items-center justify-center border border-hairline font-mono text-2xs text-gray-600 tabular-nums">
            {i + 1}
          </span>
          <span>
            <span className="font-medium text-ink-900">
              {i === 0 ? (
                <>
                  Open{" "}
                  <a
                    href={TAKEOUT_URL}
                    target="_blank"
                    rel="noopener"
                    className="text-link"
                  >
                    takeout.google.com
                  </a>
                </>
              ) : (
                step.label
              )}
            </span>
            <span className="block text-gray-600">{step.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function TakeoutImport({
  actionPath,
  onboarding = false,
  placesBootstrap,
}: {
  actionPath: string;
  onboarding?: boolean;
  /** The project's Places bootstrap rows per environment (replaced on import). */
  placesBootstrap: PlacesBootstrapView[];
}) {
  const inputId = useId();
  const fetcher = useFetcher<{ error?: string }>();
  const [read, setRead] = useState<ReadState>({ state: "idle" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [environment, setEnvironment] = useState<"live" | "test">("live");
  const [complete, setComplete] = useState(true);
  const submitting = fetcher.state !== "idle";

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setRead({ state: "reading", progress: null });
    try {
      const result = await readTakeoutSelection([...files], (progress) =>
        setRead({ state: "reading", progress }),
      );
      setSelected(new Set(result.locations.map((l) => l.locationId)));
      setComplete(result.fromArchives);
      setRead({ state: "ready", result });
    } catch (error) {
      setRead({
        state: "error",
        message:
          error instanceof TakeoutReadError
            ? error.message
            : "The file could not be read.",
      });
    }
  };

  const chosen: TakeoutLocation[] = useMemo(
    () =>
      read.state === "ready"
        ? read.result.locations.filter((l) => selected.has(l.locationId))
        : [],
    [read, selected],
  );
  const totals = useMemo(() => {
    const reviews = chosen.reduce((n, l) => n + l.reviews.length, 0);
    const starOnly = chosen.reduce((n, l) => n + l.starOnly, 0);
    return { reviews, starOnly, withText: reviews - starOnly };
  }, [chosen]);
  const places = placesBootstrap.find((p) => p.environment === environment);
  const days = indexingDaysEstimate(totals.withText);

  const submit = () => {
    if (read.state !== "ready" || chosen.length === 0) return;
    const payload = buildTakeoutPayload(
      chosen,
      read.result.fromArchives && complete,
    );
    const form = new FormData();
    form.set(
      "payload",
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
      "takeout.json",
    );
    form.set("environment", environment);
    if (places) form.set("supersede_places", "1");
    if (onboarding) form.set(ONBOARDING_FLAG, "1");
    fetcher.submit(form, {
      method: "post",
      action: actionPath,
      encType: "multipart/form-data",
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <label
          htmlFor={inputId}
          className="mb-1.5 block font-mono text-label font-medium uppercase tracking-label text-gray-600"
        >
          Takeout export
        </label>
        <input
          id={inputId}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          multiple
          disabled={read.state === "reading" || submitting}
          onChange={(event) => onFiles(event.currentTarget.files)}
          className="block w-full border border-hairline bg-surface-card px-3 py-2 text-small text-ink-900 file:mr-3 file:border-0 file:bg-ink-900 file:px-3 file:py-1.5 file:font-mono file:text-label file:font-semibold file:uppercase file:tracking-label file:text-on-dark"
        />
        <Help>
          The .zip from Google (every part, if it was split), or the
          reviews*.json files from its Google Business Profile folder. It is
          opened here, in your browser; only the reviews are sent.
        </Help>
      </div>

      {read.state === "reading" && (
        <p className="m-0 text-small text-gray-600" aria-live="polite">
          <FileArchive
            size={14}
            strokeWidth={1.75}
            aria-hidden
            className="mr-1.5 inline align-[-2px]"
          />
          Reading
          {read.progress
            ? ` ${read.progress.file}: ${formatBytes(read.progress.bytesRead)} of ${formatBytes(read.progress.totalBytes)}`
            : "…"}
        </p>
      )}
      {read.state === "error" && <FormNotice>{read.message}</FormNotice>}

      {read.state === "ready" && (
        <>
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-2 font-mono text-label font-medium uppercase tracking-label text-gray-600">
              {read.result.locations.length === 1
                ? "Location"
                : "Locations for this project"}
            </legend>
            <ul className="m-0 flex list-none flex-col divide-y divide-hairline border border-hairline p-0">
              {read.result.locations.map((location) => (
                <li key={location.locationId} className="px-3 py-2.5">
                  <label className="flex items-start gap-3 text-small">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selected.has(location.locationId)}
                      disabled={read.result.locations.length === 1}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.currentTarget.checked)
                          next.add(location.locationId);
                        else next.delete(location.locationId);
                        setSelected(next);
                      }}
                    />
                    <span className="flex-1">
                      <span className="font-medium text-ink-900">
                        {location.title ?? `Location ${location.locationId}`}
                      </span>
                      <span className="block font-mono text-label text-gray-500 tabular-nums">
                        {location.reviews.length.toLocaleString("en-US")}{" "}
                        {location.reviews.length === 1 ? "review" : "reviews"}
                        {location.starOnly > 0 &&
                          ` · ${location.starOnly.toLocaleString("en-US")} star-only, skipped`}
                        {" · id "}
                        {location.locationId}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {read.result.locations.length > 1 && (
              <Help>
                An export holds every profile you manage. Tick only the ones
                this project's site should show.
              </Help>
            )}
          </fieldset>

          {read.result.mapsReviews && (
            <FormNotice tone="neutral">
              The archive also has Google Maps' Reviews.json (reviews you wrote
              about other places). It was ignored.
            </FormNotice>
          )}

          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-1.5 font-mono text-label font-medium uppercase tracking-label text-gray-600">
              Environment
            </legend>
            <div className="flex gap-5">
              {(["live", "test"] as const).map((env) => (
                <label
                  key={env}
                  className="inline-flex items-center gap-2 text-small text-ink-900"
                >
                  <input
                    type="radio"
                    name="takeout-environment"
                    value={env}
                    checked={environment === env}
                    onChange={() => setEnvironment(env)}
                  />
                  {env === "live" ? "Live" : "Test"}
                  <Badge tone={env === "live" ? "positive" : "neutral"}>
                    {env === "live" ? "Served to your site" : "Test keys only"}
                  </Badge>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-3 border-t border-hairline pt-4 text-small text-gray-600">
            {read.result.fromArchives ? (
              <label className="flex items-start gap-3 text-ink-900">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={complete}
                  onChange={(event) => setComplete(event.currentTarget.checked)}
                />
                <span>
                  This is my whole export: remove reviews that are no longer on
                  Google.
                  <span className="block text-gray-600">
                    A review already in this project for these locations, but
                    missing from the export and older than it, was deleted on
                    Google, and is removed here too. Leave this off if you chose
                    only some parts of a split export.
                  </span>
                </span>
              </label>
            ) : (
              <p className="m-0">
                Loose JSON files may be a subset of the export, so nothing
                already in the project is removed. Import the whole .zip to also
                remove reviews deleted on Google.
              </p>
            )}
            <p className="m-0">
              Importing again later is safe: new and edited reviews are picked
              up, unchanged ones are left alone, and an older export never
              overwrites a newer edit.
            </p>
            {places && (
              <FormNotice tone="caution">
                This replaces the {places.reviews}{" "}
                {places.reviews === 1 ? "review" : "reviews"} imported from
                Google Places
                {places.places.length > 0
                  ? ` (${places.places.join(", ")})`
                  : ""}{" "}
                in {environment}. Those were Google's sample of five; the export
                has all of them, and the Places copies stop refreshing.
              </FormNotice>
            )}
            {days !== null && (
              <FormNotice tone="neutral">
                About {totals.withText.toLocaleString("en-US")} reviews: all are
                stored right away, and indexing for search runs at about{" "}
                {DAILY_INDEXING_CAPACITY.toLocaleString("en-US")} a day on the
                current plan, so they all become searchable over about {days}{" "}
                days. The progress page shows where it is.
              </FormNotice>
            )}
          </div>

          {fetcher.data?.error && <FormNotice>{fetcher.data.error}</FormNotice>}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
            <span className="text-small text-gray-500 tabular-nums">
              {totals.withText.toLocaleString("en-US")} with text to import
              {totals.starOnly > 0 &&
                `, ${totals.starOnly.toLocaleString("en-US")} star-only skipped`}
              {read.result.duplicates > 0 &&
                `, ${read.result.duplicates.toLocaleString("en-US")} repeats merged`}
            </span>
            <Button
              type="button"
              onClick={submit}
              disabled={
                submitting || chosen.length === 0 || totals.withText === 0
              }
            >
              {submitting
                ? "Starting"
                : `Import ${totals.withText.toLocaleString("en-US")} ${totals.withText === 1 ? "review" : "reviews"}`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
