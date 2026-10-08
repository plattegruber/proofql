// @vitest-environment happy-dom
// The Takeout page through createRoutesStub: the export steps, reading the
// chosen files in the browser, the location picker, the Places replacement
// notice, and what the action receives — the chosen locations' reviews and
// nothing else.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import TakeoutImportPage from "./app.projects.$slug.import.takeout";

// happy-dom rewrites import.meta.url, so resolve from the package root.
const TAKEOUT = resolve(
  process.cwd(),
  "../../packages/core/test/fixtures/takeout/Takeout",
);
const GBP = `${TAKEOUT}/Google Business Profile/`;

function looseFile(path: string, name = "reviews.json"): File {
  return new File([readFileSync(`${GBP}${path}`, "utf8")], name, {
    type: "application/json",
  });
}

type Received = { form: FormData | null };

function renderPage(
  placesBootstrap: {
    environment: "live" | "test";
    reviews: number;
    places: string[];
  }[] = [],
  received: Received = { form: null },
) {
  const Stub = createRoutesStub([
    {
      path: "/app/projects/:slug/import/takeout",
      action: async ({ request }) => {
        received.form = await request.formData();
        return { error: "stop here" };
      },
      Component: () => (
        <TakeoutImportPage
          loaderData={{
            project: { slug: "harbor", name: "Harbor Light Bakery" },
            actionPath: "/app/projects/harbor/import/takeout",
            placesBootstrap,
            onboarding: false,
          }}
          actionData={undefined}
          params={{ slug: "harbor" }}
          matches={[] as never}
        />
      ),
    },
  ]);
  render(<Stub initialEntries={["/app/projects/harbor/import/takeout"]} />);
  return received;
}

function choose(files: File[]) {
  const input = screen.getByLabelText("Takeout export") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

describe("the Takeout page", () => {
  afterEach(cleanup);

  it("explains how to export, step by step", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", {
        name: "Import from Google Takeout",
      }),
    ).toBeTruthy();
    const steps = screen
      .getByRole("heading", { name: "Export from Google" })
      .closest("section");
    for (const text of [
      "takeout.google.com",
      "Select Deselect all",
      "Then tick only Google Business Profile.",
      "Select Next step, then Create export",
      "Keep the file type .zip.",
    ]) {
      expect(steps?.textContent).toContain(text);
    }
    expect(
      screen
        .getByRole("link", { name: "takeout.google.com" })
        .getAttribute("href"),
    ).toBe("https://takeout.google.com/");
    expect(steps?.textContent).toContain("no reviewer photos or links");
  });

  it("reads the files, lets the user pick locations, and posts only those reviews", async () => {
    const received = renderPage([
      { environment: "live", reviews: 5, places: ["Harbor Light Bakery"] },
    ]);
    choose([
      looseFile("account-1009/location-2001/reviews.json"),
      looseFile(
        "account-1009/location-2001/reviews-ABHRLXUfakePageTokenQ2.json",
        "reviews-ABHRLXUfakePageTokenQ2.json",
      ),
      looseFile("account-1009/location-2002/reviews.json"),
    ]);

    const main = await screen.findByLabelText(/Location 2001/);
    const pearl = screen.getByLabelText(/Location 2002/);
    expect((main as HTMLInputElement).checked).toBe(true);
    expect((pearl as HTMLInputElement).checked).toBe(true);
    expect(main.closest("label")?.textContent).toContain(
      "23 reviews · 2 star-only, skipped",
    );
    // Loose files may be a subset: nothing will be removed.
    expect(document.body.textContent).toContain(
      "Loose JSON files may be a subset of the export",
    );
    expect(document.body.textContent).toContain(
      "This replaces the 5 reviews imported from Google Places (Harbor Light Bakery) in live.",
    );

    fireEvent.click(pearl);
    const button = screen.getByRole("button", { name: "Import 21 reviews" });
    fireEvent.click(button);

    await waitFor(() => expect(received.form).not.toBeNull());
    const form = received.form as FormData;
    expect(form.get("environment")).toBe("live");
    expect(form.get("supersede_places")).toBe("1");
    const payload = JSON.parse(await (form.get("payload") as File).text());
    expect(payload.format).toBe("proofql.takeout.v1");
    expect(payload.complete).toBe(false);
    expect(
      payload.locations.map((l: { location_id: string }) => l.location_id),
    ).toEqual(["2001"]);
    expect(payload.locations[0].reviews).toHaveLength(23);
    expect(await screen.findByText("stop here")).toBeTruthy();
  });

  it("says why a Maps Reviews.json is the wrong file", async () => {
    renderPage();
    choose([
      new File(
        [readFileSync(`${TAKEOUT}/Maps (your places)/Reviews.json`, "utf8")],
        "Reviews.json",
      ),
    ]);
    expect(
      await screen.findByText(/the reviews you wrote about other places/),
    ).toBeTruthy();
  });
});
