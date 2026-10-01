// @vitest-environment happy-dom
// Review detail through createRoutesStub: full text, metadata, every chunk
// with kind/offsets/embedded, and the inline hide confirm.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import ReviewDetailPage, {
  type ReviewDetailData,
} from "./app.projects.$slug.reviews.$id";

const TEXT =
  "Dr. Patel did my implant and I honestly forgot it wasn't my own tooth within a week. The front desk explained every charge before I paid. Parking behind the building was easy.";

function fixture(
  overrides: Partial<ReviewDetailData["review"]> = {},
): ReviewDetailData {
  return {
    project: { slug: "cedar-ridge-dental", name: "Cedar Ridge Dental" },
    review: {
      id: "11111111-1111-4111-8111-111111111111",
      environment: "live",
      source: "google",
      externalId: "demo-g01",
      rating: 5,
      text: TEXT,
      authorName: "Marisa Delgado",
      authorAvatarUrl: null,
      occurredAt: "2026-09-24T17:00:00.000Z",
      url: "https://maps.google.com/?cid=1",
      language: "en",
      metadata: { location: "north" },
      sentiment: "positive",
      sentimentSource: "rating",
      hidden: false,
      hiddenAt: null,
      status: "indexed",
      indexedAt: "2026-09-24T17:00:05.000Z",
      indexAttempts: 0,
      createdAt: "2026-09-24T17:00:01.000Z",
      updatedAt: "2026-09-24T17:00:05.000Z",
      ...overrides,
    },
    chunks: [
      {
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        kind: "full",
        text: TEXT,
        startOffset: 0,
        endOffset: TEXT.length,
        embedded: true,
        createdAt: "2026-09-24T17:00:05.000Z",
      },
      {
        id: "aaaaaaaa-0000-4000-8000-000000000002",
        kind: "window",
        text: "The front desk explained every charge before I paid. Parking behind the building was easy.",
        startOffset: TEXT.indexOf("The front desk"),
        endOffset: TEXT.length,
        embedded: false,
        createdAt: "2026-09-24T17:00:05.000Z",
      },
    ],
  };
}

function renderDetail(data: ReviewDetailData) {
  const Stub = createRoutesStub([
    {
      path: "/app/projects/:slug/reviews/:id",
      Component: () => (
        <ReviewDetailPage
          loaderData={data}
          params={{ slug: data.project.slug, id: data.review.id }}
          matches={[] as never}
          actionData={undefined}
        />
      ),
      action: () => ({ ok: true, intent: "hide", changed: 1 }),
    },
  ]);
  return render(
    <Stub
      initialEntries={[
        `/app/projects/cedar-ridge-dental/reviews/${data.review.id}`,
      ]}
    />,
  );
}

describe("review detail route", () => {
  afterEach(cleanup);

  it("renders the text, the metadata, and every chunk with kind, offsets and embedding state", async () => {
    const { container } = renderDetail(fixture());
    expect(
      await screen.findByRole("heading", { name: /Marisa Delgado/ }),
    ).toBeTruthy();
    expect(screen.getAllByText(TEXT)).toHaveLength(2); // the review and its full chunk

    expect(screen.getByRole("heading", { name: "Chunks · 2" })).toBeTruthy();
    const items = container.querySelectorAll("ol > li");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("full");
    expect(items[0]?.textContent).toContain(`offsets 0–${TEXT.length}`);
    expect(items[0]?.textContent).toContain("embedded");
    expect(items[1]?.textContent).toContain("window");
    expect(items[1]?.textContent).toContain(
      `offsets ${TEXT.indexOf("The front desk")}–${TEXT.length}`,
    );
    expect(items[1]?.textContent).toContain("not embedded");

    expect(screen.getByText("demo-g01")).toBeTruthy();
    expect(screen.getByText("location")).toBeTruthy();
    expect(screen.getByText("north")).toBeTruthy();
    expect(screen.getByTitle("positive · from rating")).toBeTruthy();
    expect(screen.getByText("Visible to queries")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "All reviews" }).getAttribute("href"),
    ).toBe("/app/projects/cedar-ridge-dental/reviews");
    expect(container.textContent).not.toContain("!");
  });

  it("asks before hiding, inline, and can back out", async () => {
    renderDetail(fixture());
    const hide = await screen.findByRole("button", { name: "Hide review" });
    expect(screen.queryByRole("form", { name: "Confirm hide" })).toBeNull();
    fireEvent.click(hide);
    expect(screen.getByRole("form", { name: "Confirm hide" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Confirm hide" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide review" })).toBeTruthy();
  });

  it("offers unhide without a confirm when the review is hidden", async () => {
    renderDetail(
      fixture({ hidden: true, hiddenAt: "2026-09-25T09:00:00.000Z" }),
    );
    expect(await screen.findByRole("button", { name: "Unhide" })).toBeTruthy();
    expect(screen.getByText(/Hidden since/)).toBeTruthy();
    expect(screen.getByText("hidden", { selector: "span" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "All reviews" }).getAttribute("href"),
    ).toBe("/app/projects/cedar-ridge-dental/reviews");
  });
});
