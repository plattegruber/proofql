// Import step 1 (#38): choose the file, the environment and the export
// format. The action stores the file in R2, opens the `ingest_runs` row
// and sends the user on to the mapping step. Below the form, the Places
// bootstrap (#47) — find the business on Google, import its five public
// reviews — for projects that did not take it during onboarding.
import { REVIEW_SOURCES } from "@proofql/core";
import { MapPin, Upload } from "lucide-react";
import { data, Form, redirect, useNavigation } from "react-router";

import {
  PLACES_CARD_BODY,
  PLACES_CARD_TITLE,
  PlacesFinder,
} from "~/components/import/places-finder";
import { PageHeader } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field, FormNotice, Help, Input, Select } from "~/components/ui/field";
import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { getCloudflare } from "~/lib/context";
import {
  createUpload,
  ImportError,
  MAX_UPLOAD_BYTES,
  uploadOptionsSchema,
} from "~/lib/csv.server";
import { withRequestDb } from "~/lib/db.server";
import {
  formatBytes,
  PROFILE_OPTIONS,
  SOURCE_LABELS,
} from "~/lib/import-labels";
import { importMapPath } from "~/lib/import-paths";
import { ONBOARDING_FLAG } from "~/lib/onboarding";
import { placesActionPath } from "~/lib/places";
import { placesConfigured } from "~/lib/places.server";
import type { Route } from "./+types/app.projects.$slug.import._index";

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const project = await withRequestDb(args.context, (db) =>
    findProjectBySlug(db, account.id, args.params.slug),
  );
  if (!project) throw data(null, { status: 404 });
  const { env } = getCloudflare(args.context);
  return {
    project: { slug: project.slug, name: project.name },
    maxBytes: MAX_UPLOAD_BYTES,
    places: {
      enabled: placesConfigured(env),
      actionPath: placesActionPath(project.slug),
    },
    // Started from the guided onboarding (#53): the run returns there.
    onboarding:
      new URL(args.request.url).searchParams.get(ONBOARDING_FLAG) === "1",
  };
}

export async function action(args: Route.ActionArgs) {
  const { account } = await requireAccount(args);
  const { log } = getCloudflare(args.context);
  const project = await withRequestDb(args.context, (db) =>
    findProjectBySlug(db, account.id, args.params.slug),
  );
  if (!project) throw data(null, { status: 404 });

  // Refuse before reading a body that cannot be accepted anyway.
  const declared = Number(args.request.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    return data(
      {
        error: `The file is larger than ${formatBytes(MAX_UPLOAD_BYTES)}. Split it and import the parts one at a time.`,
      },
      { status: 413 },
    );
  }

  const form = await args.request.formData();
  const file = form.get("file");
  const onboarding = form.get(ONBOARDING_FLAG) === "1";
  const environment = form.get("environment") === "test" ? "test" : "live";
  const options = uploadOptionsSchema.safeParse({
    profile: form.get("profile") || undefined,
    source: form.get("source") || undefined,
  });
  if (!(file instanceof File) || file.size === 0) {
    return data(
      { error: "Choose a .csv or .json file to import." },
      { status: 400 },
    );
  }
  if (!options.success) {
    return data(
      { error: "Pick a format and a source from the lists." },
      { status: 400 },
    );
  }

  try {
    const bytes = await file.arrayBuffer();
    const { runId } = await withRequestDb(args.context, (db) =>
      createUpload(db, getCloudflare(args.context).env.UPLOADS, {
        projectId: project.id,
        environment,
        filename: file.name,
        contentType: file.type,
        bytes,
      }),
    );
    log.log("import.uploaded", {
      project_id: project.id,
      ingest_run_id: runId,
      environment,
      bytes: file.size,
      profile: options.data.profile,
    });
    return redirect(
      importMapPath(project.slug, runId, {
        profile: options.data.profile,
        source: options.data.source,
        ...(onboarding ? { [ONBOARDING_FLAG]: "1" } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof ImportError) {
      return data({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `Import · ${data.project.name} · ProofQL` : "ProofQL" },
];

export default function ImportUpload({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <>
      <PageHeader
        overline="Step 1 of 3"
        title="Import reviews"
        description={
          loaderData.places.enabled
            ? "Upload an export from your review platform and map its columns on the next screen, or pull your public Google reviews below."
            : "Upload an export from your review platform and map its columns on the next screen."
        }
      />
      <Form
        method="post"
        encType="multipart/form-data"
        className="max-w-2xl border border-hairline bg-surface-card p-5"
        aria-label="Upload a review export"
      >
        {loaderData.onboarding && (
          <input type="hidden" name={ONBOARDING_FLAG} value="1" />
        )}
        <Field
          label="File"
          htmlFor="file"
          help={`.csv or .json, up to ${formatBytes(loaderData.maxBytes)}. Google Takeout's Reviews.json works as is.`}
        >
          <Input
            id="file"
            name="file"
            type="file"
            accept=".csv,.json,text/csv,application/json"
            required
            className="file:mr-3 file:border-0 file:bg-ink-900 file:px-3 file:py-1.5 file:font-mono file:text-label file:font-semibold file:uppercase file:tracking-label file:text-on-dark"
          />
        </Field>

        <fieldset className="mt-5 border-0 p-0">
          <legend className="mb-1.5 font-mono text-label font-medium uppercase tracking-label text-gray-600">
            Environment
          </legend>
          <div className="flex gap-5">
            <label className="inline-flex items-center gap-2 text-small text-ink-900">
              <input
                type="radio"
                name="environment"
                value="live"
                defaultChecked
              />
              Live
              <Badge tone="positive">Served to your site</Badge>
            </label>
            <label className="inline-flex items-center gap-2 text-small text-ink-900">
              <input type="radio" name="environment" value="test" />
              Test
              <Badge tone="neutral">Test keys only</Badge>
            </label>
          </div>
          <Help>
            Test data lives beside live data and can be wiped without touching
            it.
          </Help>
        </fieldset>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <Field
            label="Export format"
            htmlFor="profile"
            help="Detection reads the header row; pick a format only if it guesses wrong."
          >
            <Select id="profile" name="profile" defaultValue="auto">
              <option value="auto">Detect automatically</option>
              {PROFILE_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Source"
            htmlFor="source"
            help="Stored on every review that has no source column of its own."
          >
            <Select id="source" name="source" defaultValue="auto">
              <option value="auto">From the format</option>
              {REVIEW_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {actionData?.error && (
          <div className="mt-5">
            <FormNotice>{actionData.error}</FormNotice>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between gap-3 border-t border-hairline pt-5">
          <span className="text-small text-gray-500">
            Nothing is written to your project until you confirm the mapping.
          </span>
          <Button type="submit" disabled={busy}>
            <Upload size={14} strokeWidth={2} aria-hidden />
            {busy ? "Uploading" : "Continue"}
          </Button>
        </div>
      </Form>

      {/* Shown only where GOOGLE_PLACES_API_KEY is set: an option the user
          cannot use is not offered at all. */}
      {loaderData.places.enabled && (
        <section
          aria-labelledby="places-heading"
          className="mt-6 max-w-2xl border border-hairline bg-surface-card p-5"
        >
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center border border-hairline text-ink-900">
              <MapPin size={18} strokeWidth={1.75} aria-hidden />
            </span>
            <div>
              <h2
                id="places-heading"
                className="m-0 text-title font-semibold text-ink-900"
              >
                {PLACES_CARD_TITLE}
              </h2>
              <p className="mt-1 mb-0 text-small text-gray-600">
                {PLACES_CARD_BODY}
              </p>
            </div>
          </div>
          <div className="mt-5 border-t border-hairline pt-4">
            <PlacesFinder
              actionPath={loaderData.places.actionPath}
              enabled={loaderData.places.enabled}
              chooseEnvironment
            />
          </div>
        </section>
      )}
    </>
  );
}
