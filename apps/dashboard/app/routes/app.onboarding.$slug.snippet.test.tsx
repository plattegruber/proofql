// @vitest-environment happy-dom
// Step 4: the tag with the real key and the suggested query, the copy
// button, the preview iframe, the three-line guide, the finish form; and
// the expired-key variant pointing at Keys.
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub, useLoaderData } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import OnboardingSnippet from "./app.onboarding.$slug.snippet";

type LoaderData = Parameters<typeof OnboardingSnippet>[0]["loaderData"];

const SNIPPET =
  '<div data-proofql data-query="implant parking" data-limit="3"></div>\n<script async src="http://localhost:8800/v1.js" data-key="pq_pk_live_KEY123" data-api="http://localhost:8797"></script>';

const base: LoaderData = {
  project: { name: "Cedar Ridge Dental", slug: "cedar" },
  query: "implant parking",
  counts: { reviews: 80, indexed: 80, indexing: 0 },
  hasKey: true,
  snippet: SNIPPET,
  demoHref:
    "http://localhost:8800/demo/?key=pq_pk_live_KEY123&api=http%3A%2F%2Flocalhost%3A8797",
  previewHref: "/app/onboarding/cedar/preview",
  previewOrigin: "http://localhost:8799",
  keysHref: "/app/projects/cedar/keys",
  playgroundHref: "/app/projects/cedar/playground",
};

function renderStep(data: LoaderData) {
  const Stub = createRoutesStub([
    {
      path: "/app/onboarding/:slug/snippet",
      loader: () => data,
      action: () => null,
      Component: () => (
        <OnboardingSnippet
          loaderData={useLoaderData() as LoaderData}
          actionData={undefined}
          params={{ slug: "cedar" }}
          matches={[] as never}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/app/onboarding/cedar/snippet"]} />);
}

describe("onboarding step 4", () => {
  afterEach(cleanup);

  it("shows the prefilled tag, the preview, the guide and the finish form", async () => {
    const { container } = renderStep(base);
    expect(
      await screen.findByRole("heading", { name: "Your snippet" }),
    ).toBeTruthy();
    expect(screen.getByTestId("snippet-tag").textContent).toBe(SNIPPET);
    expect(screen.getByRole("button", { name: "Copy snippet" })).toBeTruthy();
    expect(screen.getByText('"implant parking"')).toBeTruthy();

    const frame = screen.getByTitle("Snippet preview");
    expect(frame.getAttribute("src")).toBe("/app/onboarding/cedar/preview");
    expect(
      screen.getByRole("link", { name: "Hosted demo" }).getAttribute("href"),
    ).toBe(base.demoHref);
    expect(screen.getByText("http://localhost:8799")).toBeTruthy();

    const guide = screen.getByText(/Open the template/).closest("ol");
    expect(guide?.querySelectorAll("li")).toHaveLength(3);

    const finish = screen.getByRole("button", {
      name: "Finish and open the playground",
    });
    expect(
      finish.closest("form")?.querySelector('input[name="intent"]'),
    ).toHaveProperty("value", "finish");
    expect(container.textContent).not.toContain("!");
  });

  it("with the key expired, carries a placeholder and points at Keys", async () => {
    renderStep({
      ...base,
      hasKey: false,
      previewHref: null,
      snippet: SNIPPET.replace("pq_pk_live_KEY123", "pq_pk_live_…"),
    });
    expect(
      (
        await screen.findByRole("link", {
          name: "Create a new publishable key in Keys",
        })
      ).getAttribute("href"),
    ).toBe("/app/projects/cedar/keys");
    expect(screen.queryByTitle("Snippet preview")).toBeNull();
    expect(
      screen.getByText(/The preview needs the key from step 1/),
    ).toBeTruthy();
    expect(screen.getByTestId("snippet-tag").textContent).toContain(
      "pq_pk_live_…",
    );
  });

  it("below the suggestion threshold, renders recency mode and says to add a query later", async () => {
    const tag = SNIPPET.replace(' data-query="implant parking"', "");
    renderStep({
      ...base,
      query: null,
      counts: { reviews: 5, indexed: 5, indexing: 0 },
      snippet: tag,
    });
    expect(
      await screen.findByText(/Add a query once you have more reviews/),
    ).toBeTruthy();
    expect(screen.getByText(/20 or more indexed/)).toBeTruthy();
    expect(screen.getByTestId("snippet-tag").textContent).toBe(tag);
    expect(screen.getByTestId("snippet-tag").textContent).not.toContain(
      "data-query",
    );
    expect(screen.queryByText(/No reviews are indexed yet/)).toBeNull();
  });

  it("explains the missing query when nothing is indexed", async () => {
    renderStep({
      ...base,
      query: null,
      counts: { reviews: 0, indexed: 0, indexing: 0 },
      snippet: SNIPPET.replace(' data-query="implant parking"', ""),
    });
    expect(await screen.findByText(/No reviews are indexed yet/)).toBeTruthy();
  });
});
