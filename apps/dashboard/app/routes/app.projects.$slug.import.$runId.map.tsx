// Import step 2 (#38): the first rows of the file, the detected mapping as
// one select per review field, extra columns as metadata, and a live
// validation summary computed in the browser with the same `normalizeRow`
// the import runs. Confirming stores the plan and starts the run in the
// background; the next screen polls it.
import {
  CSV_PROFILES,
  CSV_TARGET_FIELD_LABELS,
  CSV_TARGET_FIELDS,
  type CsvMapping,
  type CsvTargetField,
  csvProfile,
  metadataKeyFor,
  REVIEW_SOURCES,
  validateRows,
} from "@proofql/core";
import { useMemo, useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import { PageHeader } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field, FormNotice, Help, Label, Select } from "~/components/ui/field";
import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { runImportInBackground } from "~/lib/background.server";
import { getCloudflare } from "~/lib/context";
import {
  capInfo,
  findProjectRun,
  ImportError,
  isStarted,
  loadUploadPreview,
  mappingFromForm,
  PREVIEW_ROWS,
  proposeMapping,
  startImport,
  uploadOptionsSchema,
} from "~/lib/csv.server";
import { withRequestDb } from "~/lib/db.server";
import { importPath, importRunPath } from "~/lib/import-paths";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app.projects.$slug.import.$runId.map";
import { SOURCE_LABELS } from "./app.projects.$slug.import._index";

function rethrow(error: unknown): never {
  if (error instanceof ImportError)
    throw data(error.message, { status: error.status });
  throw error;
}

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const { env } = getCloudflare(args.context);
  const url = new URL(args.request.url);
  const options = uploadOptionsSchema.parse({
    profile: url.searchParams.get("profile") || undefined,
    source: url.searchParams.get("source") || undefined,
  });

  const { project, run } = await withRequestDb(args.context, async (db) => {
    const project = await findProjectBySlug(db, account.id, args.params.slug);
    if (!project) throw data(null, { status: 404 });
    const run = await findProjectRun(db, project.id, args.params.runId).catch(
      rethrow,
    );
    return { project, run };
  });
  if (isStarted(run)) throw redirect(importRunPath(project.slug, run.id));
  if (run.artifactKey === null)
    throw data("This run has no uploaded file.", { status: 409 });

  const preview = await loadUploadPreview(env.UPLOADS, run.artifactKey).catch(
    rethrow,
  );
  const { detected, defaults } = proposeMapping(preview, options);
  return {
    project: { slug: project.slug, name: project.name },
    run: { id: run.id, environment: run.environment },
    preview,
    detected,
    defaults,
    cap: capInfo(account.plan, project.reviewCount, preview.totalRows),
    previewRows: PREVIEW_ROWS,
    profileLabel: csvProfile(detected.profile).label,
  };
}

export async function action(args: Route.ActionArgs) {
  const { account } = await requireAccount(args);
  const { env, log } = getCloudflare(args.context);
  const form = await args.request.formData();

  try {
    const mapping = mappingFromForm(form);
    const source =
      REVIEW_SOURCES.find((s) => s === form.get("source")) ?? "custom";
    const profile = String(form.get("profile") ?? "generic");
    const headers = form.getAll("header").map(String);
    const totalRows = Number(form.get("totalRows") ?? 0);

    const { project, run } = await withRequestDb(args.context, async (db) => {
      const project = await findProjectBySlug(db, account.id, args.params.slug);
      if (!project) throw data(null, { status: 404 });
      const run = await findProjectRun(db, project.id, args.params.runId);
      await startImport(db, env.UPLOADS, run, {
        mapping,
        defaults: { source },
        profile,
        headers,
        totalRows,
      });
      return { project, run };
    });
    log.log("import.confirmed", {
      project_id: project.id,
      ingest_run_id: run.id,
      environment: run.environment,
      total_rows: totalRows,
      profile,
      fields: Object.keys(mapping.fields),
    });
    runImportInBackground(args.context, run.id);
    return redirect(importRunPath(project.slug, run.id));
  } catch (error) {
    if (error instanceof ImportError) {
      return data({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `Map columns · ${data.project.name} · ProofQL` : "ProofQL" },
];

const IGNORE = "";

export default function ImportMap({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { project, run, preview, detected, defaults, cap, profileLabel } =
    loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const [fields, setFields] = useState<Partial<Record<CsvTargetField, string>>>(
    detected.mapping.fields,
  );
  const [metadata, setMetadata] = useState<Record<string, string>>(
    detected.mapping.metadata,
  );
  const [source, setSource] = useState(defaults.source);

  const mapping: CsvMapping = useMemo(
    () => ({ fields, metadata }),
    [fields, metadata],
  );
  const summary = useMemo(
    () => validateRows(preview.rows, preview.headers, mapping, { source }),
    [preview, mapping, source],
  );
  const usedColumns = new Set(Object.values(fields));
  const extraColumns = preview.headers.filter((h) => !usedColumns.has(h));
  const ready = fields.text !== undefined && fields.occurred_at !== undefined;

  const setField = (field: CsvTargetField, column: string) =>
    setFields((prev) => {
      const next = { ...prev };
      if (column === IGNORE) delete next[field];
      else {
        // One column feeds one field.
        for (const key of Object.keys(next) as CsvTargetField[]) {
          if (next[key] === column) delete next[key];
        }
        next[field] = column;
        setMetadata((m) => {
          const { [column]: _, ...rest } = m;
          return rest;
        });
      }
      return next;
    });

  const toggleMetadata = (column: string, on: boolean) =>
    setMetadata((prev) => {
      const next = { ...prev };
      if (on) next[column] = metadataKeyFor(column);
      else delete next[column];
      return next;
    });

  return (
    <>
      <PageHeader
        overline="Step 2 of 3"
        title="Map columns"
        description={
          <>
            {preview.totalRows.toLocaleString("en-US")} rows,{" "}
            {preview.headers.length} columns. Detected as{" "}
            <span className="font-medium text-ink-900">{profileLabel}</span>
            {detected.confidence < 1 && " (partial match)"}. Reviews go to the{" "}
            <Badge tone={run.environment === "live" ? "positive" : "neutral"}>
              {run.environment}
            </Badge>{" "}
            environment.
          </>
        }
      />

      <Form
        method="post"
        className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
      >
        {preview.headers.map((h) => (
          <input key={h} type="hidden" name="header" value={h} />
        ))}
        <input type="hidden" name="totalRows" value={preview.totalRows} />
        <input type="hidden" name="profile" value={detected.profile} />
        {Object.entries(metadata).map(([column, key]) => (
          <input
            key={column}
            type="hidden"
            name={`metadata.${column}`}
            value={key}
          />
        ))}

        <div className="flex flex-col gap-6">
          <section
            aria-labelledby="fields-heading"
            className="border border-hairline bg-surface-card p-5"
          >
            <h2
              id="fields-heading"
              className="m-0 text-title font-semibold text-ink-900"
            >
              Review fields
            </h2>
            <p className="mt-1 mb-0 text-small text-gray-500">
              Text and date are required. Rows without an id get a stable one
              from their content.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {CSV_TARGET_FIELDS.map((field) => {
                const required = field === "text" || field === "occurred_at";
                return (
                  <Field
                    key={field}
                    htmlFor={`field-${field}`}
                    label={
                      <>
                        {CSV_TARGET_FIELD_LABELS[field]}
                        {required && (
                          <span className="ml-1 text-status-negative">
                            required
                          </span>
                        )}
                      </>
                    }
                  >
                    <Select
                      id={`field-${field}`}
                      name={`field.${field}`}
                      value={fields[field] ?? IGNORE}
                      onChange={(e) => setField(field, e.target.value)}
                      aria-invalid={required && fields[field] === undefined}
                    >
                      <option value={IGNORE}>
                        {required ? "Choose a column" : "Ignore"}
                      </option>
                      {preview.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </Select>
                  </Field>
                );
              })}
              <Field
                htmlFor="source"
                label="Default source"
                help={
                  fields.source
                    ? `Used where "${fields.source}" is empty.`
                    : "Stored on every review."
                }
              >
                <Select
                  id="source"
                  name="source"
                  value={source}
                  onChange={(e) =>
                    setSource(
                      REVIEW_SOURCES.find((s) => s === e.target.value) ??
                        "custom",
                    )
                  }
                >
                  {REVIEW_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {SOURCE_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </section>

          {extraColumns.length > 0 && (
            <section
              aria-labelledby="metadata-heading"
              className="border border-hairline bg-surface-card p-5"
            >
              <h2
                id="metadata-heading"
                className="m-0 text-title font-semibold text-ink-900"
              >
                Other columns
              </h2>
              <p className="mt-1 mb-0 text-small text-gray-500">
                Keep a column as{" "}
                <span className="font-mono">metadata.&lt;key&gt;</span> to
                filter on it at query time. Unchecked columns are left out.
              </p>
              <ul className="m-0 mt-4 grid list-none gap-2 p-0 sm:grid-cols-2">
                {extraColumns.map((column) => {
                  const on = metadata[column] !== undefined;
                  return (
                    <li key={column} className="flex items-center gap-2.5">
                      <input
                        id={`meta-${column}`}
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          toggleMetadata(column, e.target.checked)
                        }
                      />
                      <Label
                        htmlFor={`meta-${column}`}
                        className="normal-case tracking-normal text-ink-900"
                      >
                        {column}
                      </Label>
                      {on && (
                        <span className="font-mono text-label text-gray-500">
                          metadata.{metadata[column]}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section
            aria-labelledby="preview-heading"
            className="border border-hairline bg-surface-card p-5"
          >
            <h2
              id="preview-heading"
              className="m-0 text-title font-semibold text-ink-900"
            >
              First {Math.min(loaderData.previewRows, preview.rows.length)} rows
            </h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className="py-2 pr-3 font-mono text-label font-medium uppercase tracking-label text-gray-500">
                      Row
                    </th>
                    {preview.headers.map((h) => {
                      const target = (
                        Object.keys(fields) as CsvTargetField[]
                      ).find((f) => fields[f] === h);
                      return (
                        <th
                          key={h}
                          className="whitespace-nowrap py-2 pr-4 font-mono text-label font-medium uppercase tracking-label text-gray-500"
                        >
                          {h}
                          {target && (
                            <span className="ml-1.5 normal-case tracking-normal text-accent-700">
                              → {CSV_TARGET_FIELD_LABELS[target]}
                            </span>
                          )}
                          {metadata[h] && (
                            <span className="ml-1.5 normal-case tracking-normal text-accent-700">
                              → metadata.{metadata[h]}
                            </span>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => {
                    const rowNumber = i + 1;
                    const failed = summary.errors.some(
                      (e) => e.rowNumber === rowNumber,
                    );
                    return (
                      <tr
                        key={rowNumber}
                        className={cn(
                          "border-b border-hairline align-top",
                          failed && "bg-status-negative-bg",
                        )}
                      >
                        <td className="py-2 pr-3 font-mono text-data tabular-nums text-gray-500">
                          {rowNumber}
                        </td>
                        {preview.headers.map((h, c) => (
                          <td
                            key={h}
                            className="max-w-72 truncate py-2 pr-4 font-mono text-data text-ink-900"
                            title={row[c] ?? ""}
                          >
                            {row[c] ?? ""}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
          <section
            aria-labelledby="validation-heading"
            aria-live="polite"
            className="border border-hairline bg-surface-card p-5"
          >
            <h2
              id="validation-heading"
              className="m-0 text-title font-semibold text-ink-900"
            >
              Validation
            </h2>
            <dl className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <dt className="font-mono text-label font-medium uppercase tracking-label text-gray-500">
                  Valid rows
                </dt>
                <dd className="m-0 mt-1 font-mono text-data tabular-nums text-ink-900">
                  {summary.valid} / {summary.total}
                </dd>
              </div>
              <div>
                <dt className="font-mono text-label font-medium uppercase tracking-label text-gray-500">
                  With errors
                </dt>
                <dd
                  className={cn(
                    "m-0 mt-1 font-mono text-data tabular-nums",
                    summary.invalid > 0
                      ? "text-status-negative"
                      : "text-ink-900",
                  )}
                >
                  {summary.invalid}
                </dd>
              </div>
            </dl>
            <Help>
              Checked on the first {summary.total} rows; the run checks every
              row and reports the rest.
            </Help>
            {summary.errors.length > 0 && (
              <ul className="m-0 mt-4 flex list-none flex-col gap-2 p-0">
                {summary.errors.slice(0, 8).map(({ rowNumber, errors }) => (
                  <li key={rowNumber} className="text-small text-ink-900">
                    <span className="font-mono text-data text-gray-500">
                      Row {rowNumber}
                    </span>{" "}
                    {errors.map((e) => e.message).join(" ")}
                  </li>
                ))}
                {summary.errors.length > 8 && (
                  <li className="text-small text-gray-500">
                    and {summary.errors.length - 8} more
                  </li>
                )}
              </ul>
            )}
            {summary.warnings.length > 0 && summary.errors.length === 0 && (
              <p className="mt-3 mb-0 text-small text-gray-500">
                {summary.warnings.length} rows import with a detail left out (an
                empty author or a bad URL).
              </p>
            )}
          </section>

          {cap.wouldReject > 0 && (
            <FormNotice tone="caution">
              This project holds {cap.reviewCount.toLocaleString("en-US")} of{" "}
              {cap.limit.toLocaleString("en-US")} reviews on its plan, with room
              for {cap.room.toLocaleString("en-US")} more. Up to{" "}
              {cap.wouldReject.toLocaleString("en-US")} new rows in this file
              will be rejected; rows that update an existing review are not
              affected.
            </FormNotice>
          )}

          {actionData?.error && <FormNotice>{actionData.error}</FormNotice>}

          <div className="flex flex-col gap-3 border border-hairline bg-surface-card p-5">
            <Button type="submit" disabled={!ready || busy}>
              {busy
                ? "Starting"
                : `Import ${preview.totalRows.toLocaleString("en-US")} rows`}
            </Button>
            {!ready && (
              <Help className="mt-0">
                Map the review text and the date to continue.
              </Help>
            )}
            <Link
              to={importPath(project.slug)}
              className="text-center font-mono text-label uppercase tracking-label text-gray-600 no-underline hover:text-ink-900"
            >
              Upload a different file
            </Link>
          </div>
        </aside>
      </Form>
      <p className="mt-6 mb-0 text-small text-gray-500">
        Formats with built-in detection:{" "}
        {CSV_PROFILES.filter((p) => p.id !== "generic")
          .map((p) => p.label)
          .join(", ")}
        .
      </p>
    </>
  );
}
