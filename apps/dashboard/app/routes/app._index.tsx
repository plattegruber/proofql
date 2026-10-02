// Overview (#36, #54): the account, its plan and usage against the plan's
// limits, and its projects. "New project" leads to the create form (#37),
// which enforces the plan's project limit. Limits come from PLANS in
// @proofql/core; usage from `projects.review_count` and this month's
// `usage` row — the same numbers the api enforces.
import {
  PRICING_URL,
  planFor,
  planLabel,
  usageMonthStart,
} from "@proofql/core";
import { FolderOpen } from "lucide-react";
import { Link, redirect } from "react-router";

import { Overline, PageHeader } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { UsageMeter } from "~/components/usage-meter";
import { requireAccount } from "~/lib/account.server";
import { listProjectsForAccount } from "~/lib/accounts";
import { withRequestDb } from "~/lib/db.server";
import { ONBOARDING_PATH } from "~/lib/onboarding";
import { NO_USAGE, usageForProjects } from "~/lib/usage.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app._index";

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const month = usageMonthStart();
  const { projects, usage } = await withRequestDb(args.context, async (db) => {
    const projects = await listProjectsForAccount(db, account.id);
    const usage = await usageForProjects(
      db,
      projects.map((p) => p.id),
      month,
    );
    return { projects, usage };
  });
  // Nothing set up yet and the guided onboarding (#53) was neither finished
  // nor dismissed: that flow is the overview.
  if (projects.length === 0 && account.onboardingCompletedAt === null) {
    throw redirect(ONBOARDING_PATH);
  }
  const limits = planFor(account.plan);
  return {
    account: { name: account.name, plan: account.plan },
    plan: {
      label: planLabel(account.plan),
      badge: limits.badge,
      projects: limits.projects,
      reviewsPerProject: limits.reviewsPerProject,
      queriesPerMonth: limits.queriesPerMonth,
      pricingUrl: PRICING_URL,
    },
    month,
    projects: projects.map((p) => ({
      name: p.name,
      slug: p.slug,
      reviewCount: p.reviewCount,
      minRating: p.minRating,
      allowedOrigins: p.allowedOrigins.length,
      usage: usage.get(p.id) ?? NO_USAGE,
    })),
  };
}

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `${data.account.name} · ProofQL` : "ProofQL" },
];

/** "October 2026" for the `usage.month` key, in UTC like the key itself. */
export function monthLabel(month: string): string {
  return new Date(`${month}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { account, plan, month, projects } = loaderData;
  const isPaid = account.plan === "paid";
  return (
    <>
      <PageHeader
        overline="Overview"
        title={account.name}
        description={
          <span className="inline-flex items-center gap-3">
            <Badge tone={isPaid ? "positive" : "neutral"}>
              {plan.label} plan
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

      <section aria-labelledby="usage-heading" className="mb-8">
        <Overline id="usage-heading" className="mb-3">
          Plan and usage
        </Overline>
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <dl className="m-0 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
              <Stat label="Plan" value={plan.label} />
              <Stat
                label="Projects"
                value={`${projects.length} / ${plan.projects.toLocaleString("en-US")}`}
              />
              <Stat
                label="Snippet badge"
                value={
                  plan.badge ? `Shown on the ${plan.label} plan` : "Not shown"
                }
              />
              <Stat label="Usage month" value={monthLabel(month)} />
            </dl>
            {!isPaid && (
              <div className="flex flex-col items-start gap-2">
                <a
                  href={plan.pricingUrl}
                  className={cn(
                    buttonVariants({ variant: "primary", size: "sm" }),
                    "no-underline",
                  )}
                >
                  Upgrade
                </a>
                <p className="m-0 max-w-64 text-small text-gray-600">
                  The paid plan raises every limit and removes the badge.
                </p>
              </div>
            )}
          </div>

          {projects.length > 0 && (
            <ul className="m-0 mt-5 list-none divide-y divide-hairline border-t border-hairline p-0">
              {projects.map((project) => (
                <li
                  key={project.slug}
                  className="grid grid-cols-1 gap-4 py-4 md:grid-cols-[minmax(0,1fr)_2fr_2fr] md:items-start md:gap-8"
                >
                  <div className="min-w-0">
                    <Link
                      to={`/app/projects/${project.slug}`}
                      className="text-small font-semibold text-ink-900 no-underline hover:text-accent-700"
                    >
                      {project.name}
                    </Link>
                    <div className="mt-0.5 font-mono text-label text-gray-500">
                      {project.slug}
                    </div>
                  </div>
                  <UsageMeter
                    label="Reviews"
                    used={project.reviewCount}
                    limit={plan.reviewsPerProject}
                    note={
                      project.reviewCount >= plan.reviewsPerProject
                        ? "At the limit: new reviews are refused until you upgrade or delete some."
                        : `${(plan.reviewsPerProject - project.reviewCount).toLocaleString("en-US")} remaining`
                    }
                  />
                  <UsageMeter
                    label="Queries this month"
                    used={project.usage.uncached}
                    limit={plan.queriesPerMonth}
                    note={
                      project.usage.uncached >= plan.queriesPerMonth
                        ? `At the limit: uncached queries are refused until ${monthLabel(nextMonth(month))}. Cached queries keep working.`
                        : `${project.usage.cacheHits.toLocaleString("en-US")} cache hits (free) · ${project.usage.queries.toLocaleString("en-US")} answered`
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

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

/** `YYYY-MM-01` of the month after `month`. */
function nextMonth(month: string): string {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return usageMonthStart(d);
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
