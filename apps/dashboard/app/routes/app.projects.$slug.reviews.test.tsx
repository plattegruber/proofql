// @vitest-environment happy-dom
// Review browser rendered through createRoutesStub with stubbed loader data:
// the table's judgments, the muted hidden row, selection → bulk bar, and the
// two empty states.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import ProjectReviews, { type loader } from "./app.projects.$slug.reviews";

type LoaderData = Awaited<ReturnType<typeof loader>>;

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

function fixture(overrides: Partial<LoaderData> = {}): LoaderData {
  return {
    project: { slug: "cedar-ridge-dental", name: "Cedar Ridge Dental" },
    environment: "live",
    filters: { hidden: "all", indexed: "all" },
    cursor: null,
    rows: [
      {
        id: ids[0] as string,
        source: "google",
        rating: 5,
        text: "Dr. Patel did my implant and I honestly forgot it wasn't my own tooth within a week. Zero pain after the second day, and the front desk explained every charge.",
        authorName: "Marisa Delgado",
        occurredAt: "2026-09-24T17:00:00.000Z",
        hidden: false,
        status: "indexed",
        sentiment: "positive",
        sentimentSource: "rating",
        chunkCount: 3,
      },
      {
        id: ids[1] as string,
        source: "custom",
        rating: null,
        text: "Billing was a mess and nobody called back.",
        authorName: null,
        occurredAt: null,
        hidden: true,
        status: "indexed",
        sentiment: "negative",
        sentimentSource: "model",
        chunkCount: 1,
      },
      {
        id: ids[2] as string,
        source: "yelp",
        rating: 4,
        text: "Fine.",
        authorName: "T. Nguyen",
        occurredAt: "2026-01-02T00:00:00.000Z",
        hidden: false,
        status: "stuck",
        sentiment: null,
        sentimentSource: null,
        chunkCount: 0,
      },
    ],
    nextCursor: "next",
    sources: ["custom", "google", "yelp"],
    ...overrides,
  };
}

function renderReviews(data: LoaderData, path = "/app/projects/cedar-ridge-dental/reviews") {
  const Stub = createRoutesStub([
    {
      path: "/app/projects/:slug/reviews",
      Component: () => (
        <ProjectReviews
          loaderData={data}
          params={{ slug: "cedar-ridge-dental" }}
          matches={[] as never}
          actionData={undefined}
        />
      ),
    },
    { path: "/app/projects/:slug/reviews/:id", Component: () => <p>detail</p> },
  ]);
  return render(<Stub initialEntries={[path]} />);
}

describe("reviews route", () => {
  afterEach(cleanup);

  it("renders a row per review with its judgments, muting hidden ones", async () => {
    const { container } = renderReviews(fixture());
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(4); // head + 3

    // Excerpt is cut, linked to the detail route.
    const excerpt = screen.getByRole("link", { name: /Dr\. Patel did my implant/ });
    expect(excerpt.getAttribute("href")).toBe(
      `/app/projects/cedar-ridge-dental/reviews/${ids[0]}`,
    );
    expect(excerpt.textContent?.endsWith("…")).toBe(true);
    expect(excerpt.textContent?.length ?? 0).toBeLessThanOrEqual(121);

    expect(screen.getByRole("img", { name: "5 out of 5 stars" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Unrated" })).toBeTruthy();
    expect(screen.getAllByText("indexed", { selector: "span" })).toHaveLength(2);
    expect(screen.getByText("stuck")).toBeTruthy();
    expect(screen.getByTitle("positive · from rating")).toBeTruthy();
    expect(screen.getByTitle("negative · model")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getAllByText("visible")).toHaveLength(2);
    expect(screen.getByText("hidden", { selector: "td span" })).toBeTruthy();

    const hiddenRow = container.querySelector("tr[data-hidden]");
    expect(hiddenRow?.className).toContain("text-gray-500");
    expect(container.querySelectorAll("tr[data-hidden]")).toHaveLength(1);

    expect(screen.getByRole("link", { name: "Next page" }).getAttribute("href")).toBe(
      "/app/projects/cedar-ridge-dental/reviews?cursor=next",
    );
    expect(container.textContent).not.toContain("!");
  });

  it("shows the bulk bar once rows are selected, with every id in the form", async () => {
    renderReviews(fixture());
    await screen.findByRole("table");
    expect(screen.queryByRole("form", { name: "Bulk actions" })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /Select review by Marisa/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /unknown author/ }));

    const bar = screen.getByRole("form", { name: "Bulk actions" });
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide selected" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unhide selected" })).toBeTruthy();
    const hiddenIds = [...bar.querySelectorAll('input[name="id"]')].map(
      (el) => (el as HTMLInputElement).value,
    );
    expect(hiddenIds.sort()).toEqual([ids[0], ids[1]]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    expect(screen.getByText("3 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("form", { name: "Bulk actions" })).toBeNull();
  });

  it("explains the empty project and points at the ways in", async () => {
    const { container } = renderReviews(
      fixture({ rows: [], nextCursor: null, sources: [] }),
    );
    expect(await screen.findByText("No reviews yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "import tab" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "API docs" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(container.textContent).not.toContain("!");
  });

  it("offers to clear filters when they are what hides everything", async () => {
    renderReviews(
      fixture({
        rows: [],
        nextCursor: null,
        environment: "test",
        filters: { hidden: "hidden", indexed: "all", source: "yelp" },
      }),
      "/app/projects/cedar-ridge-dental/reviews?env=test&hidden=hidden&source=yelp",
    );
    expect(await screen.findByText("No reviews match these filters")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe(
      "/app/projects/cedar-ridge-dental/reviews?env=test",
    );
    // The environment toggle keeps the test environment current.
    expect(screen.getByRole("link", { name: "test" }).getAttribute("aria-current")).toBe("true");
  });
});
