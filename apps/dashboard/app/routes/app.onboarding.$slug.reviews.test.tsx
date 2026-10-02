// @vitest-environment happy-dom
// Step 2: three equal cards; Google is disabled with the waiting-on-Google
// line; the API card carries the curl with the real secret key and polls
// the status resource when asked.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub, useLoaderData } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import OnboardingReviews from "./app.onboarding.$slug.reviews";

type LoaderData = {
  project: { name: string; slug: string };
  counts: { reviews: number; indexed: number; indexing: number };
  hasSecret: boolean;
  curl: string;
  importHref: string;
  keysHref: string;
  indexingHref: string;
  statusHref: string;
};

const base: LoaderData = {
  project: { name: "Cedar Ridge Dental", slug: "cedar" },
  counts: { reviews: 0, indexed: 0, indexing: 0 },
  hasSecret: true,
  curl: "curl -s -X POST 'http://localhost:8797/v1/reviews' \\\n  -H 'Authorization: Bearer pq_sk_live_SECRET123' …",
  importHref: "/app/projects/cedar/import?onboarding=1",
  keysHref: "/app/projects/cedar/keys",
  indexingHref: "/app/onboarding/cedar/indexing",
  statusHref: "/app/onboarding/cedar/status",
};

function renderStep(
  data: LoaderData,
  status = { reviews: 3, indexed: 0, indexing: 3 },
) {
  const Stub = createRoutesStub([
    {
      path: "/app/onboarding/:slug/reviews",
      loader: () => data,
      Component: () => (
        <OnboardingReviews
          loaderData={useLoaderData() as LoaderData}
          actionData={undefined}
          params={{ slug: "cedar" }}
          matches={[] as never}
        />
      ),
    },
    { path: "/app/onboarding/:slug/status", loader: () => status },
    {
      path: "/app/onboarding/:slug/indexing",
      Component: () => <h1>Indexing</h1>,
    },
  ]);
  return render(<Stub initialEntries={["/app/onboarding/cedar/reviews"]} />);
}

describe("onboarding step 2", () => {
  afterEach(cleanup);

  it("shows the three options with Google disabled", async () => {
    const { container } = renderStep(base);
    expect(
      await screen.findByRole("heading", { name: "Add your reviews" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Upload a file" }).getAttribute("href"),
    ).toBe("/app/projects/cedar/import?onboarding=1");
    const google = screen
      .getByRole("heading", { name: "Connect Google" })
      .closest("section");
    expect(google?.getAttribute("aria-disabled")).toBe("true");
    expect(google?.textContent).toContain("Coming soon");
    expect(google?.textContent).toContain(
      "We are waiting on Google's API approval.",
    );
    expect(google?.textContent).not.toContain("#44");
    expect(
      screen.getByRole("link", { name: "Follow along" }).getAttribute("href"),
    ).toContain("/issues/44");
    expect(container.textContent).toContain("pq_sk_live_SECRET123");
    expect(container.textContent).not.toContain("!");
  });

  it("checks for reviews and announces what arrived", async () => {
    renderStep(base);
    fireEvent.click(
      await screen.findByRole("button", { name: "Check for reviews" }),
    );
    expect(
      await screen.findByText("3 reviews received. Moving on to indexing."),
    ).toBeTruthy();
    // Then the page moves itself on.
    expect(
      await screen.findByRole(
        "heading",
        { name: "Indexing" },
        { timeout: 3_000 },
      ),
    ).toBeTruthy();
  });

  it("points at Keys when the secret key is no longer known, and offers to continue when reviews exist", async () => {
    renderStep({
      ...base,
      hasSecret: false,
      counts: { reviews: 12, indexed: 12, indexing: 0 },
    });
    expect(
      (
        await screen.findByRole("link", { name: "Create a new one in Keys" })
      ).getAttribute("href"),
    ).toBe("/app/projects/cedar/keys");
    expect(
      screen
        .getByRole("link", { name: "Continue to indexing" })
        .getAttribute("href"),
    ).toBe("/app/onboarding/cedar/indexing");
    expect(screen.getByText("12")).toBeTruthy();
  });
});
