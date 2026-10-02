// @vitest-environment happy-dom
// Step 3: the API-path meter reads "Indexing n of m", the import path shows
// the import's own progress, and a settled page offers the snippet.
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub, useLoaderData } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import OnboardingIndexing from "./app.onboarding.$slug.indexing";

type LoaderData = Parameters<typeof OnboardingIndexing>[0]["loaderData"];

const base: LoaderData = {
  project: { name: "Cedar Ridge Dental", slug: "cedar" },
  counts: { reviews: 340, indexed: 212, indexing: 128 },
  progress: null,
  runHref: null,
  settled: false,
  snippetHref: "/app/onboarding/cedar/snippet",
  reviewsHref: "/app/onboarding/cedar/reviews",
};

function renderStep(data: LoaderData) {
  const Stub = createRoutesStub([
    {
      path: "/app/onboarding/:slug/indexing",
      loader: () => data,
      Component: () => (
        <OnboardingIndexing
          loaderData={useLoaderData() as LoaderData}
          actionData={undefined}
          params={{ slug: "cedar" }}
          matches={[] as never}
        />
      ),
    },
    {
      path: "/app/onboarding/:slug/snippet",
      Component: () => <h1>Snippet</h1>,
    },
  ]);
  return render(<Stub initialEntries={["/app/onboarding/cedar/indexing"]} />);
}

describe("onboarding step 3", () => {
  afterEach(cleanup);

  it("reads the API-path progress as 'Indexing n of m reviews'", async () => {
    renderStep(base);
    expect(
      await screen.findByRole("heading", {
        name: "Indexing 212 of 340 reviews",
      }),
    ).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Reviews indexed" });
    expect(bar.getAttribute("aria-valuenow")).toBe("212");
    expect(bar.getAttribute("aria-valuemax")).toBe("340");
    expect(screen.getByText(/128 waiting on the pipeline/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Show my snippet" })).toBeNull();
  });

  it("shows the import's own progress after an upload", async () => {
    renderStep({
      ...base,
      progress: {
        status: "succeeded",
        received: 50,
        created: 47,
        updated: 0,
        skipped: 0,
        failed: 3,
        processed: 50,
        indexed: 20,
        indexing: 27,
        error: null,
      },
      runHref: "/app/projects/cedar/import/run-1",
    });
    expect(
      await screen.findByRole("region", { name: "Import progress" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Rows processed" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: /Indexing \d+ of/ }),
    ).toBeNull();
  });

  it("when settled, says so and moves on to the snippet", async () => {
    renderStep({
      ...base,
      counts: { reviews: 340, indexed: 340, indexing: 0 },
      settled: true,
    });
    expect(
      await screen.findByRole("heading", { name: "Indexed" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Show my snippet" })
        .getAttribute("href"),
    ).toBe("/app/onboarding/cedar/snippet");
    expect(
      await screen.findByRole(
        "heading",
        { name: "Snippet" },
        { timeout: 3_000 },
      ),
    ).toBeTruthy();
  });
});
