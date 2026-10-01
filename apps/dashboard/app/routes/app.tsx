// Protected layout: every route under it runs with an account in hand.
// The loader IS the auth gate — `requireAccount` redirects to /sign-in or
// /app/workspace before any child loader runs.
import { Outlet } from "react-router";

import { AppShell } from "~/components/shell/app-shell";
import { NavigationProgress } from "~/components/shell/navigation-progress";
import { requireAccount } from "~/lib/account.server";
import { listProjectsForAccount } from "~/lib/accounts";
import { withRequestDb } from "~/lib/db.server";
import type { Route } from "./+types/app";

export async function loader(args: Route.LoaderArgs) {
  const { account, mode } = await requireAccount(args);
  const projects = await withRequestDb(args.context, (db) =>
    listProjectsForAccount(db, account.id),
  );
  return {
    account: { id: account.id, name: account.name, plan: account.plan },
    mode,
    projects: projects.map((p) => ({ name: p.name, slug: p.slug })),
  };
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  return (
    <AppShell
      accountName={loaderData.account.name}
      mode={loaderData.mode}
      projects={loaderData.projects}
    >
      <NavigationProgress />
      <Outlet />
    </AppShell>
  );
}
