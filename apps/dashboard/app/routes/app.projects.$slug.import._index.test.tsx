// @vitest-environment happy-dom
// Step 1 (upload) rendered through createRoutesStub with stubbed loader
// data — no Clerk, no Postgres, no R2.
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import ImportUpload from "./app.projects.$slug.import._index";

function renderUpload(actionData?: { error: string }) {
  const Stub = createRoutesStub([
    {
      path: "/app/projects/:slug/import",
      Component: () => (
        <ImportUpload
          loaderData={{
            project: { slug: "cedar-ridge-dental", name: "Cedar Ridge Dental" },
            maxBytes: 10 * 1024 * 1024,
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
    const profile = screen.getByLabelText("Export format") as HTMLSelectElement;
    const labels = [...profile.options].map((o) => o.textContent);
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
    const source = screen.getByLabelText("Source") as HTMLSelectElement;
    expect([...source.options].map((o) => o.value)).toEqual([
      "auto",
      "google",
      "yelp",
      "facebook",
      "trustpilot",
      "custom",
    ]);
    expect(screen.getByText(/up to 10.0 MB/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue/i })).toBeTruthy();
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
