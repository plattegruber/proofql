// @vitest-environment happy-dom
// Overview route rendered through createRoutesStub with a stubbed loader —
// no Clerk, no Postgres — asserting the account, plan, usage panel and
// project list.
import { PLANS, PRICING_URL } from "@proofql/core";
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import Overview, { monthLabel } from "./app._index";

type LoaderData = {
  account: { name: string; plan: "free" | "paid" };
  plan: {
    label: string;
    badge: boolean;
    projects: number;
    reviewsPerProject: number;
    queriesPerMonth: number;
    pricingUrl: string;
  };
  month: string;
  projects: Array<{
    name: string;
    slug: string;
    reviewCount: number;
    minRating: number;
    allowedOrigins: number;
    usage: { queries: number; cacheHits: number; uncached: number };
  }>;
};

function planData(plan: "free" | "paid"): LoaderData["plan"] {
  const p = PLANS[plan];
  return {
    label: plan === "free" ? "Free" : "Paid",
    badge: p.badge,
    projects: p.projects,
    reviewsPerProject: p.reviewsPerProject,
    queriesPerMonth: p.queriesPerMonth,
    pricingUrl: PRICING_URL,
  };
}

function renderOverview(data: LoaderData) {
  const Stub = createRoutesStub([
    {
      path: "/app",
      // The stub supplies loaderData directly; the real loader (requireAccount
      // + Postgres) is exercised by app._index.integration.test.ts.
      Component: () => (
        <Overview
          loaderData={data}
          params={{}}
          matches={[] as never}
          actionData={undefined}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/app"]} />);
}

const cedar = {
  name: "Cedar Ridge Dental",
  slug: "cedar-ridge-dental",
  reviewCount: 80,
  minRating: 4,
  allowedOrigins: 2,
  usage: { queries: 1_240, cacheHits: 1_000, uncached: 240 },
};

describe("overview route", () => {
  afterEach(cleanup);

  it("shows the account, its plan and its projects", async () => {
    renderOverview({
      account: { name: "ProofQL Demo (seed v4)", plan: "free" },
      plan: planData("free"),
      month: "2026-10-01",
      projects: [cedar],
    });
    expect(
      await screen.findByRole("heading", { name: "ProofQL Demo (seed v4)" }),
    ).toBeTruthy();
    expect(screen.getByText("Free plan")).toBeTruthy();
    expect(screen.getByText("1 project")).toBeTruthy();
    const links = screen.getAllByRole("link", { name: "Cedar Ridge Dental" });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe(
        "/app/projects/cedar-ridge-dental",
      );
    }
    // The project card's stat; the usage meter shows "80 / 5,000" separately.
    expect(screen.getAllByText("80").length).toBeGreaterThan(0);
    expect(screen.getByText("4+")).toBeTruthy();
  });

  it("meters reviews and this month's uncached queries against the free limits", async () => {
    const { container } = renderOverview({
      account: { name: "Demo", plan: "free" },
      plan: planData("free"),
      month: "2026-10-01",
      projects: [cedar],
    });
    await screen.findByRole("heading", { name: "Demo" });

    const reviews = screen.getByRole("meter", { name: "Reviews" });
    expect(reviews.getAttribute("aria-valuenow")).toBe("80");
    expect(reviews.getAttribute("aria-valuemax")).toBe("5000");
    expect(reviews.getAttribute("aria-valuetext")).toBe("80 of 5,000 (2%)");
    expect(screen.getByText("4,920 remaining")).toBeTruthy();

    const queries = screen.getByRole("meter", { name: "Queries this month" });
    // uncached = queries - cache hits is what the plan limits.
    expect(queries.getAttribute("aria-valuenow")).toBe("240");
    expect(queries.getAttribute("aria-valuemax")).toBe("50000");
    expect(
      screen.getByText("1,000 cache hits (free) · 1,240 answered"),
    ).toBeTruthy();

    // Plan facts and the upgrade path.
    expect(screen.getByText("Shown on the Free plan")).toBeTruthy();
    expect(screen.getByText(monthLabel("2026-10-01"))).toBeTruthy();
    expect(screen.getByText("October 2026")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Upgrade" }).getAttribute("href"),
    ).toBe(PRICING_URL);
    expect(screen.getByText("1 / 1")).toBeTruthy();
    expect(container.textContent).not.toContain("!");
  });

  it("says what happens at a limit, in the meter's own words", async () => {
    renderOverview({
      account: { name: "Full", plan: "free" },
      plan: planData("free"),
      month: "2026-12-01",
      projects: [
        {
          ...cedar,
          reviewCount: 5_000,
          usage: { queries: 50_100, cacheHits: 100, uncached: 50_000 },
        },
      ],
    });
    await screen.findByRole("heading", { name: "Full" });
    expect(
      screen.getByText(/At the limit: new reviews are refused/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /At the limit: uncached queries are refused until January 2027\. Cached queries keep working\./,
      ),
    ).toBeTruthy();
    const reviews = screen.getByRole("meter", { name: "Reviews" });
    expect(reviews.getAttribute("aria-valuenow")).toBe("5000");
    expect((reviews.firstElementChild as HTMLElement).style.width).toBe("100%");
  });

  it("on the paid plan: no badge, no upgrade link, the higher limits", async () => {
    renderOverview({
      account: { name: "Agency", plan: "paid" },
      plan: planData("paid"),
      month: "2026-10-01",
      projects: [cedar, { ...cedar, name: "Second", slug: "second" }],
    });
    await screen.findByRole("heading", { name: "Agency" });
    expect(screen.getByText("Paid plan")).toBeTruthy();
    expect(screen.getByText("Not shown")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Upgrade" })).toBeNull();
    expect(screen.getByText("2 / 50")).toBeTruthy();
    const [reviews] = screen.getAllByRole("meter", { name: "Reviews" });
    expect(reviews?.getAttribute("aria-valuemax")).toBe("100000");
  });

  it("explains the empty state and keeps the voice", async () => {
    const { container } = renderOverview({
      account: { name: "Fresh Co", plan: "paid" },
      plan: planData("paid"),
      month: "2026-10-01",
      projects: [],
    });
    expect(await screen.findByText("No projects yet")).toBeTruthy();
    expect(screen.getByText("Paid plan")).toBeTruthy();
    expect(screen.getByText("0 projects")).toBeTruthy();
    expect(screen.queryAllByRole("meter")).toHaveLength(0);
    expect(
      screen.getByRole("link", { name: "New project" }).getAttribute("href"),
    ).toBe("/app/projects/new");
    expect(
      screen
        .getByRole("link", { name: "Create your first project" })
        .getAttribute("href"),
    ).toBe("/app/projects/new");
    expect(container.textContent).not.toContain("!");
  });
});
