// Protected layout: every route under it runs with an account in hand.
// The loader IS the auth gate — `requireAccount` redirects to /sign-in or
// /app/workspace before any child loader runs. It also reads-and-clears the
// one-shot flash message actions set before redirecting
// (docs/frontend-conventions.md), which <FlashToasts /> turns into a toast.
import { useEffect, useRef } from "react";
import { data, Outlet } from "react-router";

import { AppShell } from "~/components/shell/app-shell";
import { NavigationProgress } from "~/components/shell/navigation-progress";
import { showFlashToast, Toaster } from "~/components/ui/toaster";
import { requireAccount } from "~/lib/account.server";
import { listProjectsForAccount } from "~/lib/accounts";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import { type FlashMessage, readFlash } from "~/lib/flash.server";
import type { Route } from "./+types/app";

export async function loader(args: Route.LoaderArgs) {
  const { account, mode } = await requireAccount(args);
  const projects = await withRequestDb(args.context, (db) =>
    listProjectsForAccount(db, account.id),
  );
  const { flash, headers } = await readFlash(
    getCloudflare(args.context).env,
    args.request,
  );
  return data(
    {
      account: { id: account.id, name: account.name, plan: account.plan },
      mode,
      projects: projects.map((p) => ({ name: p.name, slug: p.slug })),
      flash,
    },
    // The clearing Set-Cookie; the `headers` export below forwards it.
    headers ? { headers } : undefined,
  );
}

// Child routes that don't export `headers` inherit the deepest export in
// the matched tree — this one — so the flash-clearing Set-Cookie reaches
// the response for every page under /app.
export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

/**
 * Fires a toast when the loader delivers a flash message. Keyed off the
 * flash's random id so revalidations can't replay it.
 */
function FlashToasts({ flash }: { flash: FlashMessage | null }) {
  const shownId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (flash && shownId.current !== flash.id) {
      shownId.current = flash.id;
      showFlashToast(flash);
    }
  }, [flash]);
  return null;
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  return (
    <AppShell
      accountName={loaderData.account.name}
      mode={loaderData.mode}
      projects={loaderData.projects}
    >
      <NavigationProgress />
      <Toaster />
      <FlashToasts flash={loaderData.flash} />
      <Outlet />
    </AppShell>
  );
}
