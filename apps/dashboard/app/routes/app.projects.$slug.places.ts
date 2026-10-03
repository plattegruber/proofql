// The Places bootstrap's resource route (#47): one action behind the "Find
// your business on Google" card on onboarding step 2 and on the Import tab
// (components/import/places-finder.tsx posts here with a fetcher).
//
//   intent=search  q=<text>              → { matches } for the list
//   intent=import  place_id=<id>         → imports the place's reviews and
//                  environment=live|test   redirects to the progress view:
//                  onboarding=1            step 3 with ?run=, or the Import
//                                          tab's run page
//
// Errors come back as { error } in the voice, never Google's raw text.
import {
  describePlacesError,
  type PlaceMatch,
  PlacesError,
} from "@proofql/google";
import { data, redirect } from "react-router";

import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import { importRunPath } from "~/lib/import-paths";
import { ONBOARDING_FLAG, onboardingPath } from "~/lib/onboarding";
import { placesSearchQuerySchema } from "~/lib/places";
import {
  importPlaceReviews,
  PlacesImportError,
  placesClientFor,
} from "~/lib/places.server";
import type { Route } from "./+types/app.projects.$slug.places";

export type PlacesActionData =
  | { intent: "search"; query: string; matches: PlaceMatch[]; cached: boolean }
  | { intent: "search" | "import"; error: string };

export const PLACES_NOT_CONFIGURED =
  "Google Places is not configured in this environment.";

/** Place ids are URL-safe tokens; anything else never reaches Google. */
const PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

export async function loader() {
  throw data(null, { status: 405 });
}

export async function action(args: Route.ActionArgs) {
  const { account } = await requireAccount(args);
  const { env, log } = getCloudflare(args.context);
  const project = await withRequestDb(args.context, (db) =>
    findProjectBySlug(db, account.id, args.params.slug),
  );
  if (!project) throw data(null, { status: 404 });

  const form = await args.request.formData();
  const intent = form.get("intent") === "import" ? "import" : "search";
  const fail = (error: string, status: number) =>
    data<PlacesActionData>({ intent, error }, { status });

  const places = placesClientFor(env);
  if (places === null) return fail(PLACES_NOT_CONFIGURED, 503);

  if (intent === "search") {
    const q = placesSearchQuerySchema.safeParse(form.get("q") ?? "");
    if (!q.success) {
      return fail(q.error.issues[0]?.message ?? "Type a business name.", 400);
    }
    try {
      const { matches, cached } = await places.search(q.data);
      log.log("places.searched", {
        project_id: project.id,
        q_length: q.data.length,
        results: matches.length,
        cached,
      });
      return data<PlacesActionData>(
        { intent: "search", query: q.data, matches, cached },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      if (error instanceof PlacesError) {
        log.log("places.failed", {
          level: "warn",
          project_id: project.id,
          op: "search",
          status: error.status,
          code: error.code,
          error_message: error.message,
        });
        return fail(describePlacesError(error), 502);
      }
      throw error;
    }
  }

  const placeId = String(form.get("place_id") ?? "").trim();
  if (!PLACE_ID_PATTERN.test(placeId)) {
    return fail("Pick a place from the list first.", 400);
  }
  const environment = form.get("environment") === "test" ? "test" : "live";
  const onboarding = form.get(ONBOARDING_FLAG) === "1";
  try {
    const result = await withRequestDb(args.context, (db) =>
      importPlaceReviews(
        {
          db,
          places,
          queue: {
            sendBatch: async (messages) => {
              await env.INGEST_QUEUE.sendBatch([...messages]);
            },
          },
          log,
        },
        { projectId: project.id, environment, placeId },
      ),
    );
    return redirect(
      onboarding
        ? onboardingPath("indexing", project.slug, { run: result.run.id })
        : importRunPath(project.slug, result.run.id),
    );
  } catch (error) {
    if (error instanceof PlacesImportError) {
      return fail(error.message, error.status);
    }
    if (error instanceof PlacesError) {
      log.log("places.failed", {
        level: "warn",
        project_id: project.id,
        op: "import",
        place_id: placeId,
        status: error.status,
        code: error.code,
        error_message: error.message,
      });
      return fail(describePlacesError(error), 502);
    }
    throw error;
  }
}
