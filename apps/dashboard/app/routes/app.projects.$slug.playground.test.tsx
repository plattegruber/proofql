// @vitest-environment happy-dom
// Playground through createRoutesStub with fixture results: cards in rank
// order with similarity, the floor line between the groups, below-floor
// cards flagged, took_ms, and the two copy targets.
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { curlFor, parsePlaygroundParams, snippetFor } from "~/lib/playground";
import type { PlaygroundResult } from "~/lib/playground.server";
import ProjectPlayground, {
  type PlaygroundData,
} from "./app.projects.$slug.playground";

function result(
  overrides: Partial<PlaygroundResult> & { similarity: number | null },
): PlaygroundResult {
  return {
    reviewId: "11111111-1111-4111-8111-111111111111",
    chunkId: crypto.randomUUID(),
    excerpt: "Parking behind the building was easy.",
    startOffset: 0,
    belowFloor: false,
    review: {
      rating: 5,
      authorName: "Marisa Delgado",
      source: "google",
      occurredAt: "2026-09-24T17:00:00.000Z",
      url: null,
      metadata: { location: "north" },
      text: "Parking behind the building was easy.",
    },
    ...overrides,
  };
}

function fixture(search: string, results: PlaygroundResult[]): PlaygroundData {
  const { request, fieldErrors } = parsePlaygroundParams(
    new URLSearchParams(search),
  );
  const { since: _since, ...formValues } = request;
  return {
    project: {
      slug: "cedar-ridge-dental",
      name: "Cedar Ridge Dental",
      minRating: 4,
      similarityFloor: 0.55,
    },
    apiUrl: "http://localhost:8797",
    request: formValues,
    fieldErrors,
    sources: ["google", "yelp"],
    outcome: {
      ok: true,
      results,
      policy: { minRating: 4, similarityFloor: 0.55 },
      tookMs: 17,
      embeddingMs: 3,
      searchMs: 12,
    },
    curl: curlFor(request, "http://localhost:8797"),
    snippet: snippetFor(request, "http://localhost:8797"),
  };
}

function renderPlayground(data: PlaygroundData, search: string) {
  const Stub = createRoutesStub([
    {
      path: "/app/projects/:slug/playground",
      Component: () => (
        <ProjectPlayground
          loaderData={data}
          params={{ slug: "cedar-ridge-dental" }}
          matches={[] as never}
          actionData={undefined}
        />
      ),
    },
  ]);
  return render(
    <Stub
      initialEntries={[`/app/projects/cedar-ridge-dental/playground?${search}`]}
    />,
  );
}

describe("playground route", () => {
  afterEach(cleanup);

  it("draws the floor line between above- and below-floor cards and flags the dropped ones", async () => {
    const search = "q=parking&limit=3";
    const { container } = renderPlayground(
      fixture(search, [
        result({ similarity: 0.912 }),
        result({
          similarity: 0.61,
          reviewId: "22222222-2222-4222-8222-222222222222",
          excerpt: "Downtown parking is the only hassle.",
        }),
        result({
          similarity: 0.31,
          belowFloor: true,
          reviewId: "33333333-3333-4333-8333-333333333333",
          excerpt: "Tasha is the best hygienist I've ever had.",
        }),
      ]),
      search,
    );

    expect(await screen.findByText("0.912")).toBeTruthy();
    expect(screen.getByText("0.610")).toBeTruthy();
    expect(screen.getByText("0.310")).toBeTruthy();

    const cards = container.querySelectorAll("article");
    expect(cards).toHaveLength(3);
    expect(cards[0]?.textContent).toContain("#1");
    expect(cards[2]?.textContent).toContain("#3");
    expect(cards[2]?.hasAttribute("data-below-floor")).toBe(true);
    expect(cards[1]?.hasAttribute("data-below-floor")).toBe(false);
    expect(screen.getByText("below floor (0.55)")).toBeTruthy();

    // The floor line sits after the second card and before the third.
    const line = container.querySelector("[data-floor-line]");
    expect(line?.textContent).toContain("relevance floor · 0.55");
    expect(line?.textContent).toContain("2 above · 1 below");
    const order = [...container.querySelectorAll("article, [data-floor-line]")];
    expect(order.indexOf(line as Element)).toBe(2);

    expect(screen.getByText("took_ms").nextElementSibling?.textContent).toBe(
      "17",
    );
    expect(screen.getByRole("button", { name: "Copy as curl" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy as snippet" }),
    ).toBeTruthy();
    expect(container.textContent).toContain('data-query="parking"');
    expect(container.textContent).toContain("Bearer pq_sk_live_…");
    expect(container.textContent).not.toContain("!");
  });

  it("says so when nothing clears the floor, and still shows what fell under it", async () => {
    const search = "q=mortgage";
    renderPlayground(
      fixture(search, [result({ similarity: 0.12, belowFloor: true })]),
      search,
    );
    expect(await screen.findByText(/Nothing clears the floor/)).toBeTruthy();
    expect(screen.getByText("0 above · 1 below")).toBeTruthy();
  });

  it("without a query shows the recency list and no floor line", async () => {
    const { container } = renderPlayground(
      fixture("", [result({ similarity: null }), result({ similarity: null })]),
      "",
    );
    expect(
      await screen.findByText("No query · newest publishable reviews"),
    ).toBeTruthy();
    expect(container.querySelector("[data-floor-line]")).toBeNull();
    expect(screen.getAllByText("no query · newest first")).toHaveLength(2);
    expect(container.textContent).not.toContain("data-query");
  });
});
