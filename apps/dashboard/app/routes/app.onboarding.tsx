// Onboarding step 1 (#53): name your project. One field; the slug derives
// from it. The action creates the project AND a live publishable and a live
// secret key in one transaction, keeps the plaintexts in the one-hour
// onboarding cookie for step 4, and moves on. "I'll do this later" (or
// `?skip=1`) marks the account's onboarding done so the overview stops
// redirecting here.
import { useState } from "react";
import { data, Form, Link, redirect } from "react-router";

import { Field, FormErrors } from "~/components/form/field";
import { SubmitButton } from "~/components/form/submit-button";
import { OnboardingSteps } from "~/components/onboarding/steps";
import { PageHeader } from "~/components/shell/page-header";
import { buttonVariants } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { requireAccount } from "~/lib/account.server";
import { listProjectsForAccount } from "~/lib/accounts";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import { type FieldErrors, parseFormData } from "~/lib/forms.server";
import { onboardingPath } from "~/lib/onboarding";
import {
  clearOnboardingSession,
  commitOnboardingSession,
  elapsedSince,
  logOnboardingStep,
  markOnboardingCompleted,
  mergeHeaders,
  onboardingRouteHeaders,
  readOnboardingSession,
  startOnboardingProject,
} from "~/lib/onboarding.server";
import { createProjectSchema, slugify } from "~/lib/projects";
import { projectQuota } from "~/lib/projects.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app.onboarding";

/** Mark the account done and send it to the overview. */
async function dismiss(args: Route.LoaderArgs | Route.ActionArgs) {
  const { account } = await requireAccount(args);
  const { env, log } = getCloudflare(args.context);
  const session = await readOnboardingSession(env, args.request);
  await withRequestDb(args.context, (db) =>
    markOnboardingCompleted(db, account.id),
  );
  log.log("onboarding.dismissed", {
    account_id: account.id,
    elapsed_ms: elapsedSince(session.get("startedAt")),
  });
  throw redirect("/app", {
    headers: mergeHeaders(
      await clearOnboardingSession(env, session),
      await setFlash(env, {
        tone: "neutral",
        message: "Setup skipped",
        detail: "Start it again any time from a project's Finish setup rule.",
      }),
    ),
  });
}

export async function loader(args: Route.LoaderArgs) {
  const url = new URL(args.request.url);
  if (url.searchParams.get("skip") === "1") await dismiss(args);

  const { account } = await requireAccount(args);
  const { env, log } = getCloudflare(args.context);
  const { quota, projects } = await withRequestDb(args.context, async (db) => ({
    quota: await projectQuota(db, account),
    projects: await listProjectsForAccount(db, account.id),
  }));

  // Start the five-minute clock the first time step 1 is shown.
  const session = await readOnboardingSession(env, args.request);
  let headers: Headers | undefined;
  if (!session.get("startedAt")) {
    session.set("startedAt", new Date().toISOString());
    headers = await commitOnboardingSession(env, session);
  }
  logOnboardingStep(log, "project", {
    elapsed_ms: elapsedSince(session.get("startedAt")),
    account_id: account.id,
  });

  return data(
    {
      plan: account.plan,
      quota,
      // The newest project, to offer "continue with" when one exists.
      existing: projects.at(-1)
        ? {
            name: projects.at(-1)?.name ?? "",
            slug: projects.at(-1)?.slug ?? "",
          }
        : null,
    },
    headers ? { headers } : undefined,
  );
}

export const headers = onboardingRouteHeaders;

export const meta: Route.MetaFunction = () => [{ title: "Set up · ProofQL" }];

export async function action(args: Route.ActionArgs) {
  const form = await args.request.formData();
  if (form.get("intent") === "skip") await dismiss(args);

  const { account } = await requireAccount(args);
  const { env, log } = getCloudflare(args.context);
  // The browser derives the slug as you type; a submit before hydration
  // (or without JavaScript) sends it empty, so the server derives it too.
  if (!String(form.get("slug") ?? "").trim()) {
    form.set("slug", slugify(String(form.get("name") ?? "")));
  }
  const parsed = parseFormData(createProjectSchema, form);
  if (!parsed.ok) {
    // One field on screen: slug problems are reported under the name.
    const { slug, ...rest } = parsed.fieldErrors;
    const fieldErrors: FieldErrors = { ...rest };
    if (slug) fieldErrors.name = [...(fieldErrors.name ?? []), ...slug];
    return data({ fieldErrors }, { status: 422 });
  }

  const origin = new URL(args.request.url).origin;
  const result = await withRequestDb(args.context, (db) =>
    startOnboardingProject(db, { account, ...parsed.data, origin }),
  );
  if (!result.ok) {
    const fieldErrors: FieldErrors =
      result.reason === "slug_taken"
        ? {
            name: [
              `Another project already uses the address ${parsed.data.slug}. Pick a different name.`,
            ],
          }
        : {
            "": [
              `Your ${PLAN_LABEL[account.plan] ?? account.plan} plan allows ${pluralProjects(result.quota?.limit ?? 1)}. Continue with the project you have, or delete it to start over.`,
            ],
          };
    return data({ fieldErrors }, { status: 422 });
  }

  log.log("project.created", {
    project_id: result.project.id,
    account_id: account.id,
    onboarding: true,
  });
  for (const created of [result.publishable, result.secret]) {
    log.log("api_key.created", {
      project_id: result.project.id,
      api_key_id: created.key.id,
      kind: created.key.kind,
      environment: created.key.environment,
    });
  }

  // The plaintexts live only in the cookie, for one hour (onboarding.server.ts).
  const session = await readOnboardingSession(env, args.request);
  if (!session.get("startedAt")) {
    session.set("startedAt", new Date().toISOString());
  }
  session.set("projectId", result.project.id);
  session.set("publishable", result.publishable.plaintext);
  session.set("secret", result.secret.plaintext);
  return redirect(onboardingPath("reviews", result.project.slug), {
    headers: await commitOnboardingSession(env, session),
  });
}

const PLAN_LABEL: Record<string, string> = { free: "Free", paid: "Paid" };

function pluralProjects(n: number) {
  return n === 1 ? "1 project" : `${n} projects`;
}

export default function OnboardingProject({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { quota, existing } = loaderData;
  const [name, setName] = useState("");
  const slug = slugify(name);

  return (
    <>
      <PageHeader
        overline="Set up · Step 1 of 4"
        title="Name your project"
        description="A project is one website or business. Its reviews, keys and snippet live here. Under five minutes from here to a working snippet."
      />
      <OnboardingSteps current="project" className="mb-8" />

      {quota.atLimit && existing ? (
        <Card title="Your plan is at its project limit">
          <p className="m-0 text-small text-gray-600">
            {pluralProjects(quota.limit)} included; you have {quota.used}.
            Continue setting up{" "}
            <span className="font-medium text-ink-900">{existing.name}</span>{" "}
            instead.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Link
              to={onboardingPath("reviews", existing.slug)}
              className={cn(
                buttonVariants({ size: "md" }),
                "text-on-dark! no-underline! hover:text-on-dark!",
              )}
            >
              Continue with {existing.name}
            </Link>
          </div>
        </Card>
      ) : (
        <Card className="max-w-2xl">
          <Form method="post" className="flex flex-col gap-5">
            <Field
              name="name"
              label="Project name"
              placeholder="Cedar Ridge Dental"
              autoComplete="off"
              autoFocus
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint={
                <>
                  Usually the business or the website. Dashboard address:{" "}
                  <span className="font-mono">
                    /app/projects/{slug || "your-project"}
                  </span>
                  .
                </>
              }
              errors={actionData?.fieldErrors}
            />
            <input type="hidden" name="slug" value={slug} />
            <FormErrors errors={actionData?.fieldErrors} />
            <p className="m-0 text-small text-gray-600">
              This also creates your two live keys: a publishable key for the
              snippet and a secret key for sending reviews. They are shown once,
              in the last step.
            </p>
            <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-5">
              <SubmitButton pendingLabel="Creating…">
                Create project and keys
              </SubmitButton>
              {existing && (
                <Link
                  to={onboardingPath("reviews", existing.slug)}
                  className={cn(
                    buttonVariants({ variant: "secondary", size: "md" }),
                    "text-ink-900! no-underline! hover:text-ink-900!",
                  )}
                >
                  Continue with {existing.name}
                </Link>
              )}
            </div>
          </Form>
        </Card>
      )}
      <SkipButton />
    </>
  );
}

/**
 * "I'll do this later": its own form (never nested in the create form), a
 * POST so a prefetch can never dismiss by accident. `?skip=1` on this route
 * does the same for links from elsewhere.
 */
function SkipButton() {
  return (
    <Form method="post" className="mt-5 max-w-2xl text-right">
      <input type="hidden" name="intent" value="skip" />
      <SubmitButton variant="ghost" size="sm" pendingLabel="Skipping…">
        I'll do this later
      </SubmitButton>
    </Form>
  );
}
