// Live review counts for the "Check for reviews" poll in onboarding step 2
// (#53): `{ reviews, indexed, indexing }` for the project's live
// environment. A resource route read with `fetcher.load`; never cached.
import { data } from "react-router";

import { withRequestDb } from "~/lib/db.server";
import {
  projectIndexing,
  requireOnboardingProject,
} from "~/lib/onboarding.server";
import type { Route } from "./+types/app.onboarding.$slug.status";

export async function loader(args: Route.LoaderArgs) {
  const { project } = await requireOnboardingProject(args);
  const counts = await withRequestDb(args.context, (db) =>
    projectIndexing(db, project.id),
  );
  return data(counts, { headers: { "Cache-Control": "no-store" } });
}
