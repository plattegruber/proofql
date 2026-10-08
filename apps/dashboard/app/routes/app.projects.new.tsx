// Create a project (#37). The slug derives from the name as you type until
// you edit it yourself; the server re-validates everything and enforces the
// plan's project allowance (PLANS in @proofql/core: one project on the free
// tier). At the limit the form is replaced by the upgrade message — a
// disabled form would only pose a question it cannot answer.
import { PRICING_URL, planLabel } from "@proofql/core";
import { useState } from "react";
import { data, Form, Link, redirect } from "react-router";

import { Field, FormErrors } from "~/components/form/field";
import { SubmitButton } from "~/components/form/submit-button";
import { PageHeader } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { requireAccount } from "~/lib/account.server";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import { type FieldErrors, parseForm } from "~/lib/forms.server";
import {
  createProjectSchema,
  elsewhereLimitMessage,
  slugify,
} from "~/lib/projects";
import { createProject, projectQuota } from "~/lib/projects.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app.projects.new";

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const quota = await withRequestDb(args.context, (db) =>
    projectQuota(db, account),
  );
  return { plan: account.plan, quota };
}

export const meta: Route.MetaFunction = () => [
  { title: "New project · ProofQL" },
];

export async function action(args: Route.ActionArgs) {
  // The account check is the permission check: `requireAccount` is the only
  // way to act, and the create is scoped to that account below.
  const { account } = await requireAccount(args);
  const parsed = await parseForm(createProjectSchema, args.request);
  if (!parsed.ok) {
    return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
  }

  const result = await withRequestDb(args.context, (db) =>
    createProject(db, { account, ...parsed.data }),
  );
  if (!result.ok) {
    const fieldErrors: FieldErrors =
      result.reason === "slug_taken"
        ? { slug: ["Another project in this account already uses this slug."] }
        : {
            "": [
              (result.quota && elsewhereLimitMessage(result.quota)) ??
                `Your ${planLabel(account.plan)} plan allows ${pluralProjects(result.quota?.limit ?? 1)}. Upgrade at ${PRICING_URL} to add more.`,
            ],
          };
    return data({ fieldErrors }, { status: 422 });
  }

  const { env, log } = getCloudflare(args.context);
  log.log("project.created", {
    project_id: result.project.id,
    account_id: account.id,
  });
  // Keys are the next step of onboarding: a project is useless without one.
  return redirect(`/app/projects/${result.project.slug}/keys`, {
    headers: await setFlash(env, {
      tone: "positive",
      message: "Project created",
      detail: "Create a key to start sending reviews.",
    }),
  });
}

function pluralProjects(n: number) {
  return n === 1 ? "1 project" : `${n} projects`;
}

export default function NewProject({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { plan, quota } = loaderData;
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  return (
    <>
      <PageHeader
        overline="Projects"
        title="New project"
        description="A project is one website or business: its reviews, API keys and publication policy."
      />
      {quota.atLimit ? (
        <Card title="Your plan is at its project limit">
          <div className="flex flex-col gap-3 text-small text-gray-600">
            <p className="m-0">
              <Badge tone={plan === "paid" ? "positive" : "neutral"}>
                {planLabel(plan)} plan
              </Badge>{" "}
              <span className="ml-1">
                {pluralProjects(quota.limit)} included; you have {quota.used}.
              </span>
            </p>
            {elsewhereLimitMessage(quota) && (
              <p className="m-0">{elsewhereLimitMessage(quota)}</p>
            )}
            <p className="m-0">
              {plan === "free"
                ? "The paid plan adds more projects, raises the review and query limits, and removes the snippet badge. Until billing opens, delete a project to make room."
                : "Delete a project to make room, or ask us to raise the limit for this account."}
            </p>
            <div className="mt-1 flex items-center gap-3">
              {plan === "free" && (
                <a
                  href={PRICING_URL}
                  className={cn(
                    buttonVariants({ variant: "primary", size: "sm" }),
                    "no-underline",
                  )}
                >
                  Upgrade
                </a>
              )}
              <Link
                to="/app"
                className={cn(
                  buttonVariants({ variant: "secondary", size: "sm" }),
                  "no-underline",
                )}
              >
                Back to the overview
              </Link>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <Form method="post" className="flex max-w-lg flex-col gap-5">
            <Field
              name="name"
              label="Name"
              placeholder="Cedar Ridge Dental"
              autoComplete="off"
              required
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (!slugEdited) setSlug(slugify(event.target.value));
              }}
              errors={actionData?.fieldErrors}
            />
            <Field
              name="slug"
              label="Slug"
              hint={
                <>
                  Appears in dashboard URLs: /app/projects/
                  <span className="font-mono">{slug || "your-slug"}</span>.
                  Lowercase letters, numbers and hyphens; unique within your
                  account.
                </>
              }
              autoComplete="off"
              spellCheck={false}
              required
              value={slug}
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(event.target.value);
              }}
              className="font-mono"
              errors={actionData?.fieldErrors}
            />
            <FormErrors errors={actionData?.fieldErrors} />
            <div className="flex items-center gap-3">
              <SubmitButton pendingLabel="Creating…">
                Create project
              </SubmitButton>
              <Link
                to="/app"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "md" }),
                  "no-underline",
                )}
              >
                Cancel
              </Link>
            </div>
          </Form>
        </Card>
      )}
    </>
  );
}
