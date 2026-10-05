// Settings tab (#41, plus rename/delete from #37): the publication policy
// the query API applies in SQL — minimum rating and the relevance floor —
// alongside the project's name and slug, and a Danger section that deletes
// the project. Saving the policy bumps the project's cache generation so
// the playground (and every snippet) sees the change on its next query.
import { LEXICAL_FLOOR_OFFSET, safeBumpProjectGeneration } from "@proofql/core";
import { data, Form, redirect, useFetcher } from "react-router";
import { z } from "zod";
import { Field, SelectField } from "~/components/form/field";
import { InlineConfirm } from "~/components/form/inline-confirm";
import { SubmitButton } from "~/components/form/submit-button";
import { Card } from "~/components/ui/card";
import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import { type FieldErrors, parseFormData } from "~/lib/forms.server";
import {
  MIN_RATING_OPTIONS,
  projectSettingsSchema,
  SIMILARITY_FLOOR_DEFAULT,
  SIMILARITY_FLOOR_MAX,
  SIMILARITY_FLOOR_MIN,
  SIMILARITY_FLOOR_STEP,
} from "~/lib/projects";
import { deleteProject, updateProjectSettings } from "~/lib/projects.server";
import type { Route } from "./+types/app.projects.$slug.settings";

/** The docs page's relevance section (#43); the anchor is part of its contract. */
const RELEVANCE_DOCS_URL = "https://docs.proofql.com/query#relevance";

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const project = await withRequestDb(args.context, (db) =>
    findProjectBySlug(db, account.id, args.params.slug),
  );
  if (!project) throw data(null, { status: 404 });
  return {
    project: {
      name: project.name,
      slug: project.slug,
      minRating: project.minRating,
      similarityFloor: project.similarityFloor,
      reviewCount: project.reviewCount,
    },
  };
}

const deleteSchema = z.object({
  confirm: z.string().trim(),
});

export type SettingsActionData = { fieldErrors: FieldErrors };

export async function action(args: Route.ActionArgs) {
  const { account } = await requireAccount(args);
  const { env, log } = getCloudflare(args.context);
  const form = await args.request.formData();
  const intent = form.get("intent");

  const project = await withRequestDb(args.context, (db) =>
    findProjectBySlug(db, account.id, args.params.slug),
  );
  if (!project) throw data(null, { status: 404 });
  const ids = { projectId: project.id, accountId: account.id };

  if (intent === "delete") {
    const parsed = parseFormData(deleteSchema, form);
    if (!parsed.ok || parsed.data.confirm !== project.slug) {
      return data(
        {
          fieldErrors: {
            confirm: [`Type ${project.slug} exactly to confirm.`],
          },
        },
        { status: 422 },
      );
    }
    const deleted = await withRequestDb(args.context, (db) =>
      deleteProject(db, ids),
    );
    if (!deleted) throw data(null, { status: 404 });
    // The project's cached results are unreachable without its keys, but a
    // bump costs one write and makes the orphaning explicit.
    await safeBumpProjectGeneration(env.CACHE, project.id, {
      log,
      site: "dashboard.generation_bump",
    });
    log.log("project.deleted", {
      project_id: project.id,
      account_id: account.id,
      review_count: project.reviewCount,
    });
    return redirect("/app", {
      headers: await setFlash(env, {
        tone: "neutral",
        message: "Project deleted",
        detail: `${project.name} and its reviews and keys are gone.`,
      }),
    });
  }

  if (intent !== "save") throw data("Unknown intent", { status: 400 });

  const parsed = parseFormData(projectSettingsSchema, form);
  if (!parsed.ok) {
    return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
  }
  const result = await withRequestDb(args.context, (db) =>
    updateProjectSettings(db, ids, {
      name: parsed.data.name,
      slug: parsed.data.slug,
      minRating: parsed.data.min_rating,
      similarityFloor: parsed.data.similarity_floor,
    }),
  );
  if (!result.ok) {
    if (result.reason === "not_found") throw data(null, { status: 404 });
    return data(
      {
        fieldErrors: {
          slug: ["Another project in this account already uses this slug."],
        },
      },
      { status: 422 },
    );
  }

  // After the commit, never inside it (packages/core cache-generation).
  if (result.policyChanged) {
    // Never throws (#158): the policy committed; a lost bump is logged and
    // the old results age out with the cache TTL (24 h).
    const generation = await safeBumpProjectGeneration(env.CACHE, project.id, {
      log,
      site: "dashboard.generation_bump",
    });
    log.log("project.policy_changed", {
      project_id: project.id,
      min_rating: result.project.minRating,
      similarity_floor: result.project.similarityFloor,
      generation,
    });
  }

  return redirect(`/app/projects/${result.project.slug}/settings`, {
    headers: await setFlash(env, {
      tone: "positive",
      message: "Settings saved",
      detail: result.policyChanged
        ? "Cached results were cleared; the next query uses the new policy."
        : undefined,
    }),
  });
}

export default function ProjectSettings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { project } = loaderData;
  const fieldErrors = actionData?.fieldErrors;
  const deleteFetcher = useFetcher<SettingsActionData>();
  const deleteError = deleteFetcher.data?.fieldErrors?.confirm?.[0];

  return (
    <div className="flex flex-col gap-6">
      <Form method="post" className="flex flex-col gap-6">
        <input type="hidden" name="intent" value="save" />
        <Card title="Publication policy">
          <p className="m-0 mb-5 text-small text-gray-600">
            Applied in the same SQL as the ranking on every query, so nothing
            below these lines ever reaches a page. Saving clears this project's
            cached results.
          </p>
          <div className="grid gap-5 md:grid-cols-2">
            <SelectField
              name="min_rating"
              label="Minimum rating"
              defaultValue={String(project.minRating)}
              options={MIN_RATING_OPTIONS.map((rating) => ({
                value: String(rating),
                label:
                  rating === 1
                    ? "1 star and up (everything)"
                    : `${rating} stars and up`,
              }))}
              hint="Reviews rated below this never appear in query results."
              errors={fieldErrors}
            />
            <Field
              name="similarity_floor"
              label="Similarity floor"
              type="number"
              inputMode="decimal"
              min={SIMILARITY_FLOOR_MIN}
              max={SIMILARITY_FLOOR_MAX}
              step={SIMILARITY_FLOOR_STEP}
              defaultValue={project.similarityFloor}
              hint={
                <>
                  Lower it and more reviews qualify for a query, including
                  loosely related ones; raise it and only close matches appear,
                  so some pages show nothing. The default of{" "}
                  {SIMILARITY_FLOOR_DEFAULT.toFixed(2)}, measured on real
                  queries, keeps unrelated quotes off a page. A review that
                  contains most of the query's specific words passes{" "}
                  {LEXICAL_FLOOR_OFFSET.toFixed(2)} lower, so short keyword
                  queries still find literal matches. Lower it in small steps if
                  pages you know have matching reviews show nothing;{" "}
                  <a href={RELEVANCE_DOCS_URL} className="text-link">
                    how relevance is scored
                  </a>
                  .
                </>
              }
              className="font-mono"
              errors={fieldErrors}
            />
          </div>
        </Card>

        <Card title="Project">
          <div className="grid gap-5 md:grid-cols-2">
            <Field
              name="name"
              label="Name"
              defaultValue={project.name}
              autoComplete="off"
              required
              errors={fieldErrors}
            />
            <Field
              name="slug"
              label="Slug"
              defaultValue={project.slug}
              autoComplete="off"
              spellCheck={false}
              required
              hint="Changing it moves this project's dashboard URLs; API keys and the snippet are unaffected."
              className="font-mono"
              errors={fieldErrors}
            />
          </div>
        </Card>

        <div>
          <SubmitButton pendingLabel="Saving…">Save settings</SubmitButton>
        </div>
      </Form>

      <Card title="Danger" className="border-red-700">
        <p className="m-0 mb-4 text-small text-gray-600">
          Deleting the project removes its{" "}
          {project.reviewCount.toLocaleString("en-US")} reviews, every API key,
          and every cached result. Snippets using its keys go blank. This cannot
          be undone.
        </p>
        <deleteFetcher.Form method="post">
          <InlineConfirm
            trigger="Delete project"
            triggerVariant="danger"
            message={
              <>
                This permanently deletes <strong>{project.name}</strong>. Type
                the slug to continue.
              </>
            }
            confirmLabel="Delete project"
            pendingLabel="Deleting…"
            typeToConfirm={{
              value: project.slug,
              label: `Type ${project.slug}`,
              name: "confirm",
            }}
            fetcher={deleteFetcher}
            error={deleteError}
            className="max-w-xl"
          >
            <input type="hidden" name="intent" value="delete" />
          </InlineConfirm>
        </deleteFetcher.Form>
      </Card>
    </div>
  );
}
