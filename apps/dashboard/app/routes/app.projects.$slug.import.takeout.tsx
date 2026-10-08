// Import → Google Takeout: a Business Profile's own reviews from a Takeout
// export. The page explains how to export, the picker
// (components/import/takeout-import.tsx) opens the archive in the browser,
// and the action accepts the chosen locations' reviews, opens a `takeout`
// run and starts it in the background (app/lib/takeout.server.ts). There is
// no mapping step: the format is known. From the onboarding, the progress
// shows on its indexing step, as for a file import.
import { FileArchive } from "lucide-react";
import { data, redirect } from "react-router";

import {
  TakeoutImport,
  TakeoutSteps,
} from "~/components/import/takeout-import";
import { PageHeader } from "~/components/shell/page-header";
import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { runImportInBackground } from "~/lib/background.server";
import { getCloudflare } from "~/lib/context";
import { ImportError } from "~/lib/csv.server";
import { withRequestDb } from "~/lib/db.server";
import { formatBytes } from "~/lib/import-labels";
import { importRunPath } from "~/lib/import-paths";
import { ONBOARDING_FLAG, onboardingPath } from "~/lib/onboarding";
import { takeoutPath } from "~/lib/takeout";
import {
  createTakeoutImport,
  MAX_TAKEOUT_PAYLOAD_BYTES,
  placesBootstrapSummary,
} from "~/lib/takeout.server";
import type { Route } from "./+types/app.projects.$slug.import.takeout";

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  return withRequestDb(args.context, async (db) => {
    const project = await findProjectBySlug(db, account.id, args.params.slug);
    if (!project) throw data(null, { status: 404 });
    return {
      project: { slug: project.slug, name: project.name },
      actionPath: takeoutPath(project.slug),
      placesBootstrap: await placesBootstrapSummary(db, project.id),
      onboarding:
        new URL(args.request.url).searchParams.get(ONBOARDING_FLAG) === "1",
    };
  });
}

export async function action(args: Route.ActionArgs) {
  const { account } = await requireAccount(args);
  const { env, log } = getCloudflare(args.context);

  const declared = Number(args.request.headers.get("content-length") ?? 0);
  if (declared > MAX_TAKEOUT_PAYLOAD_BYTES + 64 * 1024) {
    return data(
      {
        error: `These reviews are more than ${formatBytes(MAX_TAKEOUT_PAYLOAD_BYTES)} of text. Import fewer locations at a time.`,
      },
      { status: 413 },
    );
  }
  const form = await args.request.formData();
  const payload = form.get("payload");
  if (!(payload instanceof File) || payload.size === 0) {
    return data({ error: "Choose a Takeout export first." }, { status: 400 });
  }
  const environment = form.get("environment") === "test" ? "test" : "live";
  const onboarding = form.get(ONBOARDING_FLAG) === "1";

  try {
    const { project, runId, reviews } = await withRequestDb(
      args.context,
      async (db) => {
        const project = await findProjectBySlug(
          db,
          account.id,
          args.params.slug,
        );
        if (!project) throw data(null, { status: 404 });
        const created = await createTakeoutImport(db, env.UPLOADS, {
          projectId: project.id,
          environment,
          payload: await payload.text(),
          supersedePlaces: form.get("supersede_places") === "1",
        });
        return { project, ...created };
      },
    );
    log.log("takeout.uploaded", {
      project_id: project.id,
      ingest_run_id: runId,
      environment,
      reviews,
      bytes: payload.size,
    });
    runImportInBackground(args.context, runId, "takeout");
    if (onboarding) {
      return redirect(onboardingPath("indexing", project.slug, { run: runId }));
    }
    return redirect(importRunPath(project.slug, runId));
  } catch (error) {
    if (error instanceof ImportError) {
      return data({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export const meta: Route.MetaFunction = ({ data }) => [
  {
    title: data ? `Google Takeout · ${data.project.name} · ProofQL` : "ProofQL",
  },
];

export default function TakeoutImportPage({
  loaderData,
}: Route.ComponentProps) {
  return (
    <>
      <PageHeader
        overline="Import"
        title="Import from Google Takeout"
        description="Every review of your Google Business Profile, with your replies kept on file, from an export you download yourself. Re-import a newer export any time to pick up new and edited reviews."
      />
      <div className="grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section
          aria-labelledby="takeout-how"
          className="self-start border border-hairline bg-surface-card p-5"
        >
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center border border-hairline text-ink-900">
              <FileArchive size={18} strokeWidth={1.75} aria-hidden />
            </span>
            <h2
              id="takeout-how"
              className="m-0 text-title font-semibold text-ink-900"
            >
              Export from Google
            </h2>
          </div>
          <TakeoutSteps className="mt-4" />
          <p className="mt-4 mb-0 border-t border-hairline pt-4 text-small text-gray-600">
            Takeout has each review's text, stars, author name and date, and
            your reply. It has no reviewer photos or links, so the snippet shows
            these as "Google review" without them. Google asks that businesses
            get a reviewer's consent before using a review in their own
            marketing.
          </p>
        </section>
        <section
          aria-label="Choose the export"
          className="border border-hairline bg-surface-card p-5"
        >
          <TakeoutImport
            actionPath={loaderData.actionPath}
            onboarding={loaderData.onboarding}
            placesBootstrap={loaderData.placesBootstrap}
          />
        </section>
      </div>
    </>
  );
}
