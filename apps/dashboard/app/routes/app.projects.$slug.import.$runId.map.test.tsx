// @vitest-environment happy-dom
// Step 2 (mapping) rendered with stubbed loader data: the detected mapping
// drives the selects, the preview table shows the rows, and the validation
// summary reacts to a mapping change in the browser.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import ImportMap from "./app.projects.$slug.import.$runId.map";

/** Value of a <select> found by label; typed loosely because the worker
 * runtime types shadow the DOM's HTMLSelectElement in this project. */
function controlValue(element: HTMLElement): string {
  return (element as unknown as { value: string }).value;
}

const headers = [
  "Review ID",
  "Author",
  "Rating",
  "Date",
  "Review Text",
  "Location",
];
const rows = [
  ["r-1", "Marcus T.", "5", "2026-01-05", "Gentle and thorough.", "north"],
  [
    "r-2",
    "Priya N.",
    "excellent",
    "1/14/2026",
    "Clear about cost.",
    "downtown",
  ],
  ["r-3", "", "4", "Jan 22, 2026", "Easy parking.", "north"],
];

function renderMap(overrides: { reviewCount?: number } = {}) {
  const reviewCount = overrides.reviewCount ?? 80;
  const room = Math.max(0, 5_000 - reviewCount);
  const data = {
    onboarding: false,
    project: { slug: "cedar-ridge-dental", name: "Cedar Ridge Dental" },
    run: {
      id: "11111111-1111-4111-8111-111111111111",
      environment: "live" as const,
    },
    preview: { headers, rows, totalRows: 50 },
    detected: {
      profile: "generic" as const,
      confidence: 0,
      mapping: {
        fields: {
          external_id: "Review ID",
          author_name: "Author",
          rating: "Rating",
          occurred_at: "Date",
          text: "Review Text",
        },
        metadata: {},
      },
    },
    defaults: { source: "custom" as const },
    cap: {
      limit: 5_000,
      reviewCount,
      room,
      wouldReject: Math.max(0, 50 - room),
    },
    previewRows: 20,
    profileLabel: "Generic CSV (detect columns)",
  };
  const Stub = createRoutesStub([
    {
      path: "/app/projects/:slug/import/:runId/map",
      Component: () => (
        <ImportMap
          loaderData={data}
          actionData={undefined}
          params={{ slug: "cedar-ridge-dental", runId: data.run.id }}
          matches={[] as never}
        />
      ),
    },
  ]);
  return render(
    <Stub
      initialEntries={[
        `/app/projects/cedar-ridge-dental/import/${data.run.id}/map`,
      ]}
    />,
  );
}

describe("import step 2", () => {
  afterEach(cleanup);

  it("renders the detected mapping, the preview rows and the live validation", async () => {
    renderMap();
    expect(
      await screen.findByRole("heading", { name: "Map columns" }),
    ).toBeTruthy();
    expect(screen.getByText(/50 rows, 6 columns/)).toBeTruthy();

    expect(controlValue(screen.getByLabelText(/^Review text/))).toBe(
      "Review Text",
    );
    expect(controlValue(screen.getByLabelText(/^Date/))).toBe("Date");
    expect(controlValue(screen.getByLabelText(/^Rating/))).toBe("Rating");
    expect(controlValue(screen.getByLabelText(/^Review URL/))).toBe("");

    // Location is unmapped → offered as metadata, off by default.
    const meta = screen.getByLabelText("Location") as HTMLInputElement;
    expect(meta.type).toBe("checkbox");
    expect(meta.checked).toBe(false);

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("Gentle and thorough.")).toBeTruthy();

    // Row 2 has a bad rating: 2 of 3 valid, with the reason listed.
    const validation = screen.getByRole("region", { name: "Validation" });
    expect(within(validation).getByText("2 / 3")).toBeTruthy();
    expect(
      within(validation).getByText(/"excellent" is not a rating/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Import 50 rows" }),
    ).toHaveProperty("disabled", false);
  });

  it("re-validates when the mapping changes and blocks the run without text", async () => {
    renderMap();
    const rating = await screen.findByLabelText(/^Rating/);
    fireEvent.change(rating, { target: { value: "" } });
    const validation = screen.getByRole("region", { name: "Validation" });
    expect(within(validation).getByText("3 / 3")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^Review text/), {
      target: { value: "" },
    });
    expect(
      screen.getByRole("button", { name: "Import 50 rows" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByText("Map the review text and the date to continue."),
    ).toBeTruthy();
  });

  it("turns an extra column into metadata with a derived key", async () => {
    renderMap();
    const meta = (await screen.findByLabelText("Location")) as HTMLInputElement;
    fireEvent.click(meta);
    expect(screen.getAllByText("metadata.location").length).toBeGreaterThan(0);
    const hidden = document.querySelector(
      'input[name="metadata.Location"]',
    ) as HTMLInputElement;
    expect(hidden.value).toBe("location");
  });

  it("warns how many rows the plan cap will reject", async () => {
    renderMap({ reviewCount: 4_980 });
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      expect.stringContaining(
        "Up to 30 new rows in this file will be rejected",
      ),
    );
  });
});
