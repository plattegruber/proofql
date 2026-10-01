// Overview (#36): the account, its plan, and its projects. "New project"
// leads to the create form (#37), which enforces the plan's project limit.
import { FolderOpen } from "lucide-react";
import { Link } from "react-router";

import { Overline, PageHeader } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { requireAccount } from "~/lib/account.server";
import { listProjectsForAccount } from "~/lib/accounts";
import { withRequestDb } from "~/lib/db.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app._index";

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const projects = await withRequestDb(args.context, (db) =>
    listProjectsForAccount(db, account.id),
  );
  return {
    account: { name: account.name, plan: account.plan },
    projects: projects.map((p) => ({
      name: p.name,
      slug: p.slug,
      reviewCount: p.reviewCount,
      minRating: p.minRating,
      allowedOrigins: p.allowedOrigins.length,
    })),
  };
}

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `${data.account.name} · ProofQL` : "ProofQL" },
];

export const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  paid: "Paid",
};

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { account, projects } = loaderData;
  return (
    <>
      <PageHeader
        overline="Overview"
        title={account.name}
        description={
          <span className="inline-flex items-center gap-3">
            <Badge tone={account.plan === "paid" ? "positive" : "neutral"}>
              {PLAN_LABEL[account.plan] ?? account.plan} plan
            </Badge>
            <span className="font-mono text-data text-gray-500">
              {projects.length === 1
                ? "1 project"
                : `${projects.length} projects`}
            </span>
          </span>
        }
        action={
          <Link
            to="/app/projects/new"
            className={cn(
              buttonVariants({ variant: "secondary", size: "sm" }),
              "no-underline",
            )}
          >
            New project
          </Link>
        }
      />

      <section aria-labelledby="projects-heading">
        <Overline id="projects-heading" className="mb-3">
          Projects
        </Overline>
        {projects.length === 0 ? (
          <div className="flex flex-col items-center border border-hairline bg-surface-card px-8 py-20 text-center">
            <FolderOpen
              size={20}
              strokeWidth={1.75}
              className="text-gray-400"
              aria-hidden
            />
            <h2 className="mt-4.5 mb-0 text-title font-semibold">
              No projects yet
            </h2>
            <p className="mx-auto mt-2.5 mb-0 max-w-130 text-small text-gray-600">
              A project is one website or business: its reviews, API keys and
              publication policy.
            </p>
            <Link
              to="/app/projects/new"
              className={cn(
                buttonVariants({ variant: "primary", size: "sm" }),
                "mt-5 no-underline",
              )}
            >
              Create your first project
            </Link>
          </div>
        ) : (
          <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2">
            {projects.map((project) => (
              <li key={project.slug}>
                <Card>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        to={`/app/projects/${project.slug}`}
                        className="text-title font-semibold text-ink-900 no-underline hover:text-accent-700"
                      >
                        {project.name}
                      </Link>
                      <div className="mt-1 font-mono text-label text-gray-500">
                        {project.slug}
                      </div>
                    </div>
                  </div>
                  <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-hairline pt-3.5">
                    <Stat
                      label="Reviews"
                      value={project.reviewCount.toLocaleString("en-US")}
                    />
                    <Stat label="Min rating" value={`${project.minRating}+`} />
                    <Stat
                      label="Origins"
                      value={project.allowedOrigins.toString()}
                    />
                  </dl>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-label font-medium uppercase tracking-label text-gray-500">
        {label}
      </dt>
      <dd className="m-0 mt-1 font-mono text-data tabular-nums text-ink-900">
        {value}
      </dd>
    </div>
  );
}
