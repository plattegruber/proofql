// Import step 1 (#38): choose the file, the environment and the export
// format. The action stores the file in R2, opens the `ingest_runs` row
// and sends the user on to the mapping step.
import { CSV_PROFILES, REVIEW_SOURCES } from "@proofql/core";
import { Upload } from "lucide-react";
import { data, Form, redirect, useNavigation } from "react-router";

import { PageHeader } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field, FormNotice, Help, Input, Select } from "~/components/ui/field";
import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { getCloudflare } from "~/lib/context";
import {
  createUpload,
  formatBytes,
  ImportError,
  MAX_UPLOAD_BYTES,
  uploadOptionsSchema,
} from "~/lib/csv.server";
import { withRequestDb } from "~/lib/db.server";
import { importMapPath } from "~/lib/import-paths";
import type { Route } from "./+types/app.projects.$slug.import._index";

export const PROFILE_OPTIONS = CSV_PROFILES.map((p) => ({
  value: p.id,
  label: p.label,
}));

export const SOURCE_LABELS: Record<(typeof REVIEW_SOURCES)[number], string> = {
  google: "Google",
  yelp: "Yelp",
  facebook: "Facebook",
  trustpilot: "Trustpilot",
  custom: "Custom",
};

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const project = await withRequestDb(args.context, (db) =>
    findProjectBySlug(db, account.id, args.params.slug),
  );
  if (!project) throw data(null, { status: 404 });
  return {
    project: { slug: project.slug, name: project.name },
    maxBytes: MAX_UPLOAD_BYTES,
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
        description="Upload an export from your review platform. You will map its columns on the next screen."
      />
      <Form
        method="post"
        encType="multipart/form-data"
        className="max-w-2xl border border-hairline bg-surface-card p-5"
        aria-label="Upload a review export"
      >
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
    </>
  );
}
