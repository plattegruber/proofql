// App shell (#36): a 56px top bar — plain-type wordmark (no logo mark),
// the organization switcher, the user menu — over a 224px left nav with a
// hairline right border and a 1120px-max content column. Flat surfaces,
// hairline rules, square corners throughout.
//
// Clerk's components only mount inside <ClerkProvider>, which root.tsx
// renders when Clerk is configured; in the local auth stub the same slots
// show the account name and a "Local auth stub" badge instead.
import { OrganizationSwitcher, UserButton } from "@clerk/react-router";
import { FolderOpen, LayoutGrid, type LucideIcon } from "lucide-react";
import { NavLink } from "react-router";

import { Badge } from "~/components/ui/badge";
import type { AuthMode } from "~/lib/auth-mode";
import { clerkAppearance } from "~/lib/clerk-appearance";
import { cn } from "~/lib/utils";

export interface ShellProject {
  name: string;
  slug: string;
}

export interface AppShellProps {
  accountName: string;
  mode: Exclude<AuthMode, "unconfigured">;
  projects: ShellProject[];
  children: React.ReactNode;
}

function SideLink({
  to,
  label,
  icon: Icon,
  end,
}: {
  to: string;
  label: string;
  icon?: LucideIcon;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex w-full items-center gap-2.75 px-2.5 py-2.25 text-left",
          "font-sans text-small leading-none no-underline",
          "transition-colors duration-100 ease-out",
          "focus-visible:shadow-focus-ring focus-visible:outline-none",
          isActive
            ? "bg-accent-50 font-semibold text-accent-700 hover:text-accent-700"
            : "font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-600",
        )
      }
    >
      {Icon && (
        <Icon size={17} strokeWidth={1.75} className="shrink-0" aria-hidden />
      )}
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

export function StubBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-hairline bg-surface-sunken px-6 py-2 font-mono text-label text-gray-600"
    >
      <Badge tone="caution">Local auth stub</Badge>
      <span>
        Acting as the seeded demo account. Set CLERK_SECRET_KEY in
        apps/dashboard/.dev.vars to sign in with Clerk.
      </span>
    </div>
  );
}

export function TopBar({
  accountName,
  mode,
}: Pick<AppShellProps, "accountName" | "mode">) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-hairline bg-surface-card px-6">
      <div className="flex items-center gap-6">
        {/* The wordmark is plain type — no logo mark, by design. */}
        <a
          href="/app"
          className="font-display text-xl font-medium leading-none tracking-display text-ink-900 no-underline hover:text-ink-900"
        >
          ProofQL
        </a>
        {mode === "clerk" ? (
          <OrganizationSwitcher
            hidePersonal
            afterCreateOrganizationUrl="/app"
            afterSelectOrganizationUrl="/app"
            appearance={clerkAppearance}
          />
        ) : (
          <span className="border-l border-hairline pl-6 text-small font-medium text-ink-900">
            {accountName}
          </span>
        )}
      </div>
      <div className="flex items-center gap-4">
        {mode === "clerk" ? (
          <UserButton appearance={clerkAppearance} />
        ) : (
          <span className="font-mono text-label text-gray-500">
            {accountName}
          </span>
        )}
      </div>
    </header>
  );
}

export function AppShell({
  accountName,
  mode,
  projects,
  children,
}: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-page font-sans text-ink-900">
      {mode === "stub" && <StubBanner />}
      <TopBar accountName={accountName} mode={mode} />
      <div className="flex flex-1">
        <aside className="flex w-56 shrink-0 flex-col gap-5 border-r border-hairline bg-surface-card px-3 py-5">
          <nav aria-label="Main" className="flex flex-col gap-0.5">
            <SideLink to="/app" label="Overview" icon={LayoutGrid} end />
          </nav>
          <div>
            <div className="mb-1.5 px-2.5 font-mono text-label font-medium uppercase tracking-label text-gray-500">
              Projects
            </div>
            <nav aria-label="Projects" className="flex flex-col gap-0.5">
              {projects.length === 0 ? (
                <span className="px-2.5 py-2 text-small text-gray-500">
                  None yet
                </span>
              ) : (
                projects.map((project) => (
                  <SideLink
                    key={project.slug}
                    to={`/app/projects/${project.slug}`}
                    label={project.name}
                    icon={FolderOpen}
                  />
                ))
              )}
            </nav>
          </div>
        </aside>
        <main className="min-w-0 flex-1 px-10 pt-8 pb-18">
          <div className="mx-auto max-w-280">{children}</div>
        </main>
      </div>
    </div>
  );
}
