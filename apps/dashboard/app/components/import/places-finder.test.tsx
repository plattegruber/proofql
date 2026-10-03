// @vitest-environment happy-dom
// The "Find your business on Google" card (#47) through createRoutesStub:
// a search posts to the places route and lists the matches; "Import
// reviews" posts the place id (and the onboarding flag) and follows the
// action's redirect; errors render in the voice; without a key the card
// says so.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { PlacesFinder } from "./places-finder";

type Action = (args: { request: Request }) => Promise<unknown>;

function renderFinder(
  action: Action,
  props: Partial<Parameters<typeof PlacesFinder>[0]> = {},
) {
  const Stub = createRoutesStub([
    {
      path: "/app/projects/:slug/import",
      Component: () => (
        <PlacesFinder
          actionPath="/app/projects/cedar/places"
          enabled
          {...props}
        />
      ),
    },
    { path: "/app/projects/:slug/places", action },
    {
      path: "/app/onboarding/:slug/indexing",
      Component: () => <h1>Indexing</h1>,
    },
    {
      path: "/app/projects/:slug/import/:runId",
      Component: () => <h1>Import run</h1>,
    },
  ]);
  return render(<Stub initialEntries={["/app/projects/cedar/import"]} />);
}

const MATCHES = [
  {
    id: "ChIJcedar",
    name: "Cedar Ridge Dental",
    address: "1200 Cedar Ridge Rd, Boulder, CO 80302, USA",
    rating: 4.8,
    ratingCount: 212,
  },
  {
    id: "ChIJquiet",
    name: "Quiet Corner Books",
    address: null,
    rating: null,
    ratingCount: 0,
  },
];

async function search(text: string) {
  fireEvent.change(await screen.findByLabelText("Business name and city"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

describe("PlacesFinder", () => {
  afterEach(cleanup);

  it("searches, lists the matches with their Google stats, and imports one into onboarding", async () => {
    const posted: Record<string, string>[] = [];
    renderFinder(
      async ({ request }) => {
        const form = Object.fromEntries(
          [...(await request.formData()).entries()].map(([k, v]) => [
            k,
            String(v),
          ]),
        );
        posted.push(form);
        if (form.intent === "search") {
          return {
            intent: "search",
            query: form.q,
            matches: MATCHES,
            cached: false,
          };
        }
        return new Response(null, {
          status: 302,
          headers: { Location: "/app/onboarding/cedar/indexing?run=r1" },
        });
      },
      { onboarding: true },
    );
    await search("cedar ridge");
    const list = await screen.findByRole("list", { name: "Matching places" });
    const items = list.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Cedar Ridge Dental");
    expect(items[0]?.textContent).toContain("1200 Cedar Ridge Rd");
    expect(items[0]?.textContent).toContain("4.8 ★ · 212 ratings on Google");
    expect(items[0]?.textContent).toContain("up to 5 reviews shared");
    expect(items[1]?.textContent).toContain("Address not shared");
    expect(items[1]?.textContent).toContain("0 ratings on Google");
    expect(posted[0]).toMatchObject({ intent: "search", q: "cedar ridge" });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Import reviews from Cedar Ridge Dental",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Indexing" }),
    ).toBeTruthy();
    expect(posted[1]).toEqual({
      intent: "import",
      place_id: "ChIJcedar",
      onboarding: "1",
      environment: "live",
    });
  });

  it("offers live/test on the Import tab and lands on the run page", async () => {
    const posted: Record<string, string>[] = [];
    renderFinder(
      async ({ request }) => {
        const form = Object.fromEntries(
          [...(await request.formData()).entries()].map(([k, v]) => [
            k,
            String(v),
          ]),
        );
        posted.push(form);
        if (form.intent === "search") {
          return {
            intent: "search",
            query: form.q,
            matches: MATCHES,
            cached: true,
          };
        }
        return new Response(null, {
          status: 302,
          headers: { Location: "/app/projects/cedar/import/r2" },
        });
      },
      { chooseEnvironment: true },
    );
    await search("quiet");
    await screen.findByRole("list", { name: "Matching places" });
    const [testRadio] = screen.getAllByLabelText("Test");
    fireEvent.click(testRadio as HTMLElement);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Import reviews from Cedar Ridge Dental",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Import run" }),
    ).toBeTruthy();
    expect(posted[1]).toEqual({
      intent: "import",
      place_id: "ChIJcedar",
      environment: "test",
    });
  });

  it("shows no-match and error states in the voice", async () => {
    let calls = 0;
    const { container } = renderFinder(async () => {
      calls += 1;
      if (calls === 1) {
        return { intent: "search", query: "zzz", matches: [], cached: false };
      }
      return new Response(
        JSON.stringify({
          intent: "search",
          error: "Google Places is unavailable right now.",
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    });
    await search("zzz");
    expect(
      await screen.findByText(/Nothing on Google matches "zzz"/),
    ).toBeTruthy();
    await search("again");
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Google Places is unavailable right now.",
    );
    expect(container.textContent).not.toContain("!");
  });

  it("explains when Places is not configured", async () => {
    renderFinder(async () => null, { enabled: false });
    expect(
      await screen.findByText(/Not configured in this environment/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
  });
});
