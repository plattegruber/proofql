// Signed in, no active Organization: the "create your workspace" state.
// A Clerk Organization is an account (scope.md §2), so until one is active
// there is nothing to show. OrganizationList covers both paths — pick an
// existing organization or create one — and lands on /app afterwards, where
// requireAccount creates the `accounts` row on the first load.
import { OrganizationList } from "@clerk/react-router";
import { redirect } from "react-router";

import { Overline } from "~/components/shell/page-header";
import { requireUser } from "~/lib/account.server";
import { authMode } from "~/lib/auth-mode";
import { clerkAppearance } from "~/lib/clerk-appearance";
import { getCloudflare } from "~/lib/context";
import { APP_PATH } from "~/lib/paths";
import type { Route } from "./+types/app.workspace";

export async function loader(args: Route.LoaderArgs) {
  if (authMode(getCloudflare(args.context).env) !== "clerk") {
    throw redirect(APP_PATH);
  }
  const { orgId } = await requireUser(args);
  if (orgId) throw redirect(APP_PATH);
  return null;
}

export const meta: Route.MetaFunction = () => [
  { title: "Create your workspace · ProofQL" },
];

export default function WorkspacePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-surface-page px-6 font-sans text-ink-900">
      <div className="w-full max-w-110 text-center">
        <Overline className="mb-2.5">ProofQL</Overline>
        <h1 className="m-0 font-display text-h1 font-medium tracking-display">
          Create your workspace
        </h1>
        <p className="mt-2 mb-0 text-body text-gray-600">
          A workspace holds your projects, API keys and reviews. Name it after
          your company; you can invite teammates later.
        </p>
      </div>
      <OrganizationList
        hidePersonal
        afterCreateOrganizationUrl={APP_PATH}
        afterSelectOrganizationUrl={APP_PATH}
        appearance={clerkAppearance}
      />
    </main>
  );
}
