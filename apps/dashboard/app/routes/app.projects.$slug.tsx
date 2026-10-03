// Project shell (#36): header + section tabs. Each tab's content is its own
// issue — Reviews #39, Playground #40, Keys #37, Integrations #45, Settings
// #41 — and lands as
// a child route here.
import { data, Outlet } from "react-router";

import { FinishSetupBanner } from "~/components/onboarding/finish-setup-banner";
import { PageHeader } from "~/components/shell/page-header";
import { LinkTabs } from "~/components/ui/link-tabs";
import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { withRequestDb } from "~/lib/db.server";
import type { Route } from "./+types/app.projects.$slug";

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const project = await withRequestDb(args.context, (db) =>
    findProjectBySlug(db, account.id, args.params.slug),
  );
  if (!project) throw data(null, { status: 404 });
  return {
    project: {
      name: project.name,
      slug: project.slug,
      reviewCount: project.reviewCount,
    },
  };
}

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `${data.project.name} · ProofQL` : "ProofQL" },
];

export default function ProjectShell({ loaderData }: Route.ComponentProps) {
  const { project } = loaderData;
  const base = `/app/projects/${project.slug}`;
  return (
    <>
      <PageHeader
        overline="Project"
        title={project.name}
        description={
          <span className="font-mono text-data text-gray-500">
            {project.slug} · {project.reviewCount.toLocaleString("en-US")}{" "}
            reviews
          </span>
        }
      />
      {project.reviewCount === 0 && <FinishSetupBanner slug={project.slug} />}
      <LinkTabs
        className="mb-6"
        tabs={[
          { to: `${base}/reviews`, label: "Reviews" },
          { to: `${base}/import`, label: "Import" },
          { to: `${base}/playground`, label: "Playground" },
          { to: `${base}/keys`, label: "Keys" },
          { to: `${base}/integrations`, label: "Integrations" },
          { to: `${base}/settings`, label: "Settings" },
        ]}
      />
      <Outlet />
    </>
  );
}
