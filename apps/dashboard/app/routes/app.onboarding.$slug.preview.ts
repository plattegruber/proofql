// The step-4 preview page (#53): a bare HTML document carrying exactly the
// snippet tag step 4 shows, loaded from SNIPPET_SRC against the api, in an
// iframe on the dashboard's own origin (which step 1 added to the project's
// allowed origins). The key comes from the onboarding cookie; when it has
// expired the page says so instead of rendering a tag with a placeholder.

import { withRequestDb } from "~/lib/db.server";
import { onboardingSnippet } from "~/lib/onboarding";
import {
  requireOnboardingProject,
  sessionKeysFor,
  suggestQuery,
} from "~/lib/onboarding.server";
import type { Route } from "./+types/app.onboarding.$slug.preview";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The host page's look: system font, plenty of room, nothing of ours. */
const PREVIEW_STYLE =
  "html{height:100%}body{margin:0;min-height:100%;padding:20px 22px;box-sizing:border-box;font:15px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;background:#fff}" +
  ".pq-hint{margin:0 0 14px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#6b7280;text-transform:uppercase;letter-spacing:.06em}" +
  "[data-proofql]{color:#6b7280;font-size:14px}";

export function previewDocument(input: {
  projectName: string;
  snippet: string | null;
  query: string | null;
}): string {
  const body = input.snippet
    ? `<p class="pq-hint">${escapeHtml(input.projectName)} · ${input.query ? `data-query="${escapeHtml(input.query)}"` : "newest reviews"}</p>\n${input.snippet.replace(
        "></div>",
        ">Nothing matches yet — the snippet renders nothing rather than the wrong thing.</div>",
      )}`
    : `<p class="pq-hint">Preview unavailable</p><p>The key from step 1 has expired. Create a publishable key in Keys and try the hosted demo.</p>`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Snippet preview</title>",
    `<style>${PREVIEW_STYLE}</style>`,
    "</head><body>",
    body,
    "</body></html>",
  ].join("\n");
}

export async function loader(args: Route.LoaderArgs) {
  const { project, env, session } = await requireOnboardingProject(args);
  const { publishable } = sessionKeysFor(session, project.id);
  const query = publishable
    ? await withRequestDb(args.context, (db) => suggestQuery(db, project.id))
    : null;
  const html = previewDocument({
    projectName: project.name,
    query,
    snippet: publishable
      ? onboardingSnippet({
          query,
          key: publishable,
          snippetSrc: env.SNIPPET_SRC,
          apiUrl: env.API_URL,
        })
      : null,
  });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The page carries a plaintext key: never cached, framed only by us.
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
