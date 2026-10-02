// Onboarding step 4 (#53): your snippet. The one tag from
// packages/snippet/README.md, prefilled with the live publishable key from
// step 1 and a `data-query` suggested from the project's most common review
// topics (only once MIN_REVIEWS_FOR_SUGGESTION reviews are indexed, #106;
// below that the tag runs in recency mode); a copy button; a live preview in an iframe that loads the snippet
// from SNIPPET_SRC against this project's own data; three lines on where to
// paste it; the hosted demo. Finishing marks the account's onboarding done
// and opens the Playground.
import { ExternalLink } from "lucide-react";
import { Form, Link, redirect } from "react-router";

import { SubmitButton } from "~/components/form/submit-button";
import { OnboardingSteps } from "~/components/onboarding/steps";
import { Overline, PageHeader } from "~/components/shell/page-header";
import { buttonVariants } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { CopyButton } from "~/components/ui/copy-button";
import { FormNotice } from "~/components/ui/field";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import {
  demoUrl,
  MIN_REVIEWS_FOR_SUGGESTION,
  onboardingResourcePath,
  onboardingSnippet,
} from "~/lib/onboarding";
import {
  clearOnboardingSession,
  logOnboardingStep,
  markOnboardingCompleted,
  mergeHeaders,
  onboardingRouteHeaders,
  projectIndexing,
  requireOnboardingProject,
  sessionKeysFor,
  suggestQuery,
} from "~/lib/onboarding.server";
import { publishableKeyPlaceholder } from "~/lib/playground";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app.onboarding.$slug.snippet";

export async function loader(args: Route.LoaderArgs) {
  const { account, project, env, log, session, elapsed } =
    await requireOnboardingProject(args);
  const { publishable } = sessionKeysFor(session, project.id);
  const { query, counts } = await withRequestDb(args.context, async (db) => ({
    query: await suggestQuery(db, project.id),
    counts: await projectIndexing(db, project.id),
  }));
  logOnboardingStep(log, "snippet", {
    elapsed_ms: elapsed,
    account_id: account.id,
    project_id: project.id,
  });
  const base = `/app/projects/${project.slug}`;
  return {
    project: { name: project.name, slug: project.slug },
    query,
    counts,
    hasKey: publishable !== null,
    snippet: onboardingSnippet({
      query,
      key: publishable ?? publishableKeyPlaceholder("live"),
      snippetSrc: env.SNIPPET_SRC,
      apiUrl: env.API_URL,
    }),
    demoHref: demoUrl(env.SNIPPET_SRC, publishable, env.API_URL),
    previewHref: publishable
      ? onboardingResourcePath("preview", project.slug)
      : null,
    // The origin the preview queries from — added to allowed origins in step 1.
    previewOrigin: new URL(args.request.url).origin,
    keysHref: `${base}/keys`,
    playgroundHref: `${base}/playground`,
  };
}

export const headers = onboardingRouteHeaders;

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `Your snippet · ${data.project.name} · ProofQL` : "ProofQL" },
];

/** `intent=finish`: done. The cookie (and its plaintexts) goes with it. */
export async function action(args: Route.ActionArgs) {
  const { account, project, env, log, session, elapsed } =
    await requireOnboardingProject(args);
  await withRequestDb(args.context, (db) =>
    markOnboardingCompleted(db, account.id),
  );
  log.log("onboarding.completed", {
    account_id: account.id,
    project_id: project.id,
    elapsed_ms: elapsed,
  });
  return redirect(`/app/projects/${project.slug}/playground`, {
    headers: mergeHeaders(
      await clearOnboardingSession(env, session),
      await setFlash(env, {
        tone: "positive",
        message: "Setup complete",
        detail:
          "Paste the snippet into your site and it renders your reviews. Try queries here first.",
      }),
    ),
  });
}

export default function OnboardingSnippet({
  loaderData,
}: Route.ComponentProps) {
  const {
    query,
    counts,
    hasKey,
    snippet,
    demoHref,
    previewHref,
    previewOrigin,
    keysHref,
  } = loaderData;

  return (
    <>
      <PageHeader
        overline="Set up · Step 4 of 4"
        title="Your snippet"
        description="Two lines of HTML. Paste them where the reviews should appear and the page shows the ones that fit."
      />
      <OnboardingSteps current="snippet" className="mb-8" />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Card
            title="The tag"
            action={
              <CopyButton value={snippet} label="Snippet copied" size="sm">
                Copy snippet
              </CopyButton>
            }
          >
            <pre
              data-testid="snippet-tag"
              className="m-0 overflow-x-auto whitespace-pre-wrap break-all bg-surface-sunken p-3 font-mono text-label leading-relaxed text-ink-900"
            >
              <code>{snippet}</code>
            </pre>
            <p className="mt-3 mb-0 text-small text-gray-600">
              {query ? (
                <>
                  <span className="font-mono">data-query</span> is prefilled
                  with{" "}
                  <span className="font-medium text-ink-900">"{query}"</span>,
                  the most common topic across your reviews. Set it to whatever
                  each page is about: a service, a location, a question.
                </>
              ) : counts.reviews === 0 ? (
                <>
                  No reviews are indexed yet, so there is no{" "}
                  <span className="font-mono">data-query</span> to suggest.
                  Without one the tag shows your newest reviews; add{" "}
                  <span className="font-mono">data-query="…"</span> to match a
                  page's topic.
                </>
              ) : (
                <>
                  Add a query once you have more reviews; without one the
                  snippet shows your newest reviews. With{" "}
                  {MIN_REVIEWS_FOR_SUGGESTION} or more indexed, this step
                  suggests a <span className="font-mono">data-query</span> from
                  your most common topic; set{" "}
                  <span className="font-mono">data-query="…"</span> yourself to
                  match a page's topic any time.
                </>
              )}
            </p>
            {!hasKey && (
              <div className="mt-4">
                <FormNotice tone="caution">
                  The publishable key from step 1 was shown for one hour and is
                  not stored, so the tag carries a placeholder.{" "}
                  <Link to={keysHref} className="text-link">
                    Create a new publishable key in Keys
                  </Link>{" "}
                  and paste it into <span className="font-mono">data-key</span>.
                </FormNotice>
              </div>
            )}
          </Card>

          <Card title="Where to paste it">
            <ol className="m-0 flex list-none flex-col gap-3 p-0 text-small text-gray-600">
              <Step n={1}>
                Open the template of the page that should show reviews — a
                service page, a location page, the home page.
              </Step>
              <Step n={2}>
                Paste the <span className="font-mono">&lt;div&gt;</span> where
                the reviews go and the{" "}
                <span className="font-mono">&lt;script&gt;</span> anywhere after
                it; once per page is enough for any number of divs.
              </Step>
              <Step n={3}>
                Add the page's origin under Keys → Allowed origins, then reload.
                Matching reviews render; when nothing matches, nothing does.
              </Step>
            </ol>
          </Card>

          <Form
            method="post"
            className="flex flex-wrap items-center gap-3 border-t border-hairline pt-5"
          >
            <input type="hidden" name="intent" value="finish" />
            <SubmitButton pendingLabel="Finishing…">
              Finish and open the playground
            </SubmitButton>
            <Link
              to={keysHref}
              className={cn(
                buttonVariants({ variant: "ghost", size: "md" }),
                "text-ink-900! no-underline! hover:text-ink-900!",
              )}
            >
              Manage keys
            </Link>
          </Form>
        </div>

        <div className="flex flex-col gap-6">
          <Card
            title="Live preview"
            action={
              <a
                href={demoHref}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1.5 font-mono text-label uppercase tracking-label text-gray-600 no-underline hover:text-ink-900"
              >
                Hosted demo
                <ExternalLink size={12} strokeWidth={2} aria-hidden />
              </a>
            }
          >
            {previewHref ? (
              <iframe
                title="Snippet preview"
                src={previewHref}
                sandbox="allow-scripts allow-same-origin"
                className="block h-96 w-full border border-hairline bg-white"
              />
            ) : (
              <div className="flex h-96 items-center justify-center border border-dashed border-hairline bg-surface-sunken p-6 text-center text-small text-gray-600">
                The preview needs the key from step 1, which has expired. The
                hosted demo link above shows the snippet against the demo
                project instead.
              </div>
            )}
            <p className="mt-3 mb-0 text-small text-gray-600">
              This is your snippet, loaded as a page would load it, querying{" "}
              {counts.reviews.toLocaleString("en-US")}{" "}
              {counts.reviews === 1 ? "review" : "reviews"} with the tag above.
              The preview runs from{" "}
              <span className="font-mono">{previewOrigin}</span>, which was
              added to this project's allowed origins so it can query; remove it
              in Keys when you no longer need it.
            </p>
          </Card>
          <div className="border border-hairline bg-surface-card p-5">
            <Overline className="mb-2">Change your mind later</Overline>
            <p className="m-0 text-small text-gray-600">
              Hide a review from Reviews, raise the minimum rating or the
              relevance floor in Settings, and the snippet follows at once. The
              Playground shows exactly what any query returns, and why.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="inline-flex size-5 shrink-0 items-center justify-center border border-ink-900 font-mono text-2xs font-semibold text-ink-900">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}
