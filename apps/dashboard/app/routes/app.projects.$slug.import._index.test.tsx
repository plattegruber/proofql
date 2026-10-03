// @vitest-environment happy-dom
// Step 1 (upload) rendered through createRoutesStub with stubbed loader
// data — no Clerk, no Postgres, no R2.
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import ImportUpload from "./app.projects.$slug.import._index";

/** The <option>s of a <select> found by label (the worker runtime types
 * shadow the DOM's HTMLSelectElement in this project, so no casts). */
function optionsOf(element: HTMLElement): { value: string; label: string }[] {
  return [...element.querySelectorAll("option")].map((o) => ({
    value: o.getAttribute("value") ?? "",
    label: o.textContent ?? "",
  }));
}

function renderUpload(
  actionData?: { error: string },
  places = {
    enabled: true,
    actionPath: "/app/projects/cedar-ridge-dental/places",
  },
) {
  const Stub = createRoutesStub([
    {
      path: "/app/projects/:slug/import",
      Component: () => (
        <ImportUpload
          loaderData={{
            project: { slug: "cedar-ridge-dental", name: "Cedar Ridge Dental" },
            onboarding: false,
            maxBytes: 10 * 1024 * 1024,
            places,
          }}
          actionData={actionData}
          params={{ slug: "cedar-ridge-dental" }}
          matches={[] as never}
        />
      ),
    },
  ]);
  return render(
    <Stub initialEntries={["/app/projects/cedar-ridge-dental/import"]} />,
  );
}

describe("import step 1", () => {
  afterEach(cleanup);

  it("renders the upload form with environment, format and source choices", async () => {
    renderUpload();
    expect(
      await screen.findByRole("heading", { name: "Import reviews" }),
    ).toBeTruthy();
    const form = screen.getByRole("form", { name: "Upload a review export" });
    expect(form.getAttribute("enctype")).toBe("multipart/form-data");
    const file = screen.getByLabelText("File") as HTMLInputElement;
    expect(file.type).toBe("file");
    expect(file.accept).toContain(".csv");
    expect(file.accept).toContain(".json");
    expect((screen.getByLabelText(/^Live/) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByLabelText(/^Test/) as HTMLInputElement).checked).toBe(
      false,
    );
    const labels = optionsOf(screen.getByLabelText("Export format")).map(
      (o) => o.label,
    );
    expect(labels[0]).toBe("Detect automatically");
    for (const name of [
      "Google Takeout",
      "Yelp",
      "Trustpilot",
      "Birdeye",
      "Podium",
    ]) {
      expect(
        labels.some((l) => l?.includes(name)),
        name,
      ).toBe(true);
    }
    expect(
      optionsOf(screen.getByLabelText("Source")).map((o) => o.value),
    ).toEqual(["auto", "google", "yelp", "facebook", "trustpilot", "custom"]);
    expect(screen.getByText(/up to 10.0 MB/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue/i })).toBeTruthy();
  });

  it("offers the Places bootstrap below the form, with the live/test choice", async () => {
    renderUpload();
    const card = (
      await screen.findByRole("heading", {
        name: "Find your business on Google",
      })
    ).closest("section");
    expect(card?.getAttribute("aria-disabled")).toBeNull();
    const form = screen.getByRole("form", {
      name: "Search Google for your business",
    });
    expect(form.getAttribute("action")).toBe(
      "/app/projects/cedar-ridge-dental/places",
    );
    expect(card?.textContent).toContain(
      "connect your Google Business Profile later for all of them",
    );
  });

  it("marks the Places bootstrap not configured without a key", async () => {
    renderUpload(undefined, {
      enabled: false,
      actionPath: "/app/projects/cedar-ridge-dental/places",
    });
    const card = (
      await screen.findByRole("heading", {
        name: "Find your business on Google",
      })
    ).closest("section");
    expect(card?.getAttribute("aria-disabled")).toBe("true");
    expect(card?.textContent).toContain("Not configured in this environment.");
  });

  it("shows the action's error in the voice", async () => {
    const { container } = renderUpload({ error: "The file is empty." });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The file is empty.",
    );
    expect(container.textContent).not.toContain("!");
  });
});
