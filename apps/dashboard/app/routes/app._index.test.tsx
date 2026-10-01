// @vitest-environment happy-dom
// Overview route rendered through createRoutesStub with a stubbed loader —
// no Clerk, no Postgres — asserting the account, plan and project list.
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import Overview from "./app._index";

type LoaderData = {
  account: { name: string; plan: "free" | "paid" };
  projects: Array<{
    name: string;
    slug: string;
    reviewCount: number;
    minRating: number;
    allowedOrigins: number;
  }>;
};

function renderOverview(data: LoaderData) {
  const Stub = createRoutesStub([
    {
      path: "/app",
      // The stub supplies loaderData directly; the real loader (requireAccount
      // + Postgres) is exercised by the integration tests and `pnpm dev`.
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

describe("overview route", () => {
  afterEach(cleanup);

  it("shows the account, its plan and its projects", async () => {
    renderOverview({
      account: { name: "ProofQL Demo (seed v3)", plan: "free" },
      projects: [
        {
          name: "Cedar Ridge Dental",
          slug: "cedar-ridge-dental",
          reviewCount: 80,
          minRating: 4,
          allowedOrigins: 2,
        },
      ],
    });
    expect(
      await screen.findByRole("heading", { name: "ProofQL Demo (seed v3)" }),
    ).toBeTruthy();
    expect(screen.getByText("Free plan")).toBeTruthy();
    expect(screen.getByText("1 project")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Cedar Ridge Dental" });
    expect(link.getAttribute("href")).toBe("/app/projects/cedar-ridge-dental");
    expect(screen.getByText("80")).toBeTruthy();
    expect(screen.getByText("4+")).toBeTruthy();
  });

  it("explains the empty state and keeps the voice", async () => {
    const { container } = renderOverview({
      account: { name: "Fresh Co", plan: "paid" },
      projects: [],
    });
    expect(await screen.findByText("No projects yet")).toBeTruthy();
    expect(screen.getByText("Paid plan")).toBeTruthy();
    expect(screen.getByText("0 projects")).toBeTruthy();
    expect(screen.getByRole("button", { name: /new project/i })).toHaveProperty(
      "disabled",
      true,
    );
    expect(container.textContent).not.toContain("!");
  });
});
