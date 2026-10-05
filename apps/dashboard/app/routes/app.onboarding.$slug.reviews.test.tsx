// @vitest-environment happy-dom
// Step 2: four equal cards; "Find your business on Google" is enabled only
// with a Places key (#47); "Connect Google" is disabled with the
// waiting-on-Google line; the API card carries the curl with the real
// secret key and polls the status resource when asked.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRoutesStub, useLoaderData } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import OnboardingReviews from "./app.onboarding.$slug.reviews";

type LoaderData = {
  project: { name: string; slug: string };
  counts: {
    reviews: number;
    indexed: number;
    indexing: number;
    deferred: boolean;
  };
  hasSecret: boolean;
  curl: string;
  importHref: string;
  places: { enabled: boolean; actionPath: string };
  keysHref: string;
  indexingHref: string;
  statusHref: string;
};

const base: LoaderData = {
  project: { name: "Cedar Ridge Dental", slug: "cedar" },
  counts: { reviews: 0, indexed: 0, indexing: 0, deferred: false },
  hasSecret: true,
  curl: "curl -s -X POST 'http://localhost:8797/v1/reviews' \\\n  -H 'Authorization: Bearer pq_sk_live_SECRET123' …",
  importHref: "/app/projects/cedar/import?onboarding=1",
  places: { enabled: true, actionPath: "/app/projects/cedar/places" },
  keysHref: "/app/projects/cedar/keys",
  indexingHref: "/app/onboarding/cedar/indexing",
  statusHref: "/app/onboarding/cedar/status",
};

function renderStep(
  data: LoaderData,
  status = { reviews: 3, indexed: 0, indexing: 3, deferred: false },
  onStatus: () => void = () => {},
) {
  const Stub = createRoutesStub([
    {
      path: "/app/onboarding/:slug/reviews",
      loader: () => data,
      Component: () => (
        <OnboardingReviews
          loaderData={useLoaderData() as LoaderData}
          actionData={undefined}
          params={{ slug: "cedar" }}
          matches={[] as never}
        />
      ),
    },
    {
      path: "/app/onboarding/:slug/status",
      loader: () => {
        onStatus();
        return status;
      },
    },
    {
      path: "/app/onboarding/:slug/indexing",
      Component: () => <h1>Indexing</h1>,
    },
  ]);
  return render(<Stub initialEntries={["/app/onboarding/cedar/reviews"]} />);
}

describe("onboarding step 2", () => {
  afterEach(cleanup);

  it("shows the four options with Connect Google disabled", async () => {
    const { container } = renderStep(base);
    expect(
      await screen.findByRole("heading", { name: "Add your reviews" }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual([
      "Upload a CSV or JSON export",
      "Find your business on Google",
      "Connect Google",
      "Use the API",
    ]);
    expect(
      screen.getByRole("link", { name: "Upload a file" }).getAttribute("href"),
    ).toBe("/app/projects/cedar/import?onboarding=1");
    const google = screen
      .getByRole("heading", { name: "Connect Google" })
      .closest("section");
    expect(google?.getAttribute("aria-disabled")).toBe("true");
    expect(google?.textContent).toContain("Coming soon");
    expect(google?.textContent).toContain(
      "We are waiting on Google's API approval.",
    );
    expect(google?.textContent).not.toContain("#44");
    expect(
      screen.getByRole("link", { name: "Follow along" }).getAttribute("href"),
    ).toContain("/issues/44");
    expect(container.textContent).toContain("pq_sk_live_SECRET123");
    expect(container.textContent).not.toContain("!");
  });

  it("offers the Places search with a Places key, posting to the project's places route", async () => {
    renderStep(base);
    const card = (
      await screen.findByRole("heading", {
        name: "Find your business on Google",
      })
    ).closest("section");
    expect(card?.getAttribute("aria-disabled")).toBeNull();
    expect(card?.textContent).toContain(
      "Google shares a business's five most relevant public reviews",
    );
    expect(card?.textContent).toContain(
      "keep their author and the Google badge",
    );
    const form = screen.getByRole("form", {
      name: "Search Google for your business",
    });
    expect(form.getAttribute("action")).toBe("/app/projects/cedar/places");
    expect(form.querySelector('input[name="intent"]')).toHaveProperty(
      "value",
      "search",
    );
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
  });

  it("says Places is not configured when there is no key", async () => {
    renderStep({ ...base, places: { ...base.places, enabled: false } });
    const card = (
      await screen.findByRole("heading", {
        name: "Find your business on Google",
      })
    ).closest("section");
    expect(card?.getAttribute("aria-disabled")).toBe("true");
    expect(card?.textContent).toContain("Not configured in this environment.");
    expect(
      screen.queryByRole("form", { name: "Search Google for your business" }),
    ).toBeNull();
  });

  it("checks for reviews and announces what arrived", async () => {
    renderStep(base);
    fireEvent.click(
      await screen.findByRole("button", { name: "Check for reviews" }),
    );
    expect(
      await screen.findByText("3 reviews received. Moving on to indexing."),
    ).toBeTruthy();
    // Then the page moves itself on.
    expect(
      await screen.findByRole(
        "heading",
        { name: "Indexing" },
        { timeout: 3_000 },
      ),
    ).toBeTruthy();
  });

  it("points at Keys when the secret key is no longer known, and offers to continue when reviews exist", async () => {
    renderStep({
      ...base,
      hasSecret: false,
      counts: { reviews: 12, indexed: 12, indexing: 0, deferred: false },
    });
    expect(
      (
        await screen.findByRole("link", { name: "Create a new one in Keys" })
      ).getAttribute("href"),
    ).toBe("/app/projects/cedar/keys");
    expect(
      screen
        .getByRole("link", { name: "Continue to indexing" })
        .getAttribute("href"),
    ).toBe("/app/onboarding/cedar/indexing");
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("Check for reviews polls every 2 s for one minute per click, then stops (#162)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let loads = 0;
      renderStep(
        base,
        { reviews: 0, indexed: 0, indexing: 0, deferred: false },
        () => {
          loads += 1;
        },
      );
      const elapse = async (ms: number) => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
        return loads;
      };
      await elapse(0);
      fireEvent.click(
        screen.getByRole("button", { name: "Check for reviews" }),
      );
      expect(await elapse(0)).toBe(1);
      expect(await elapse(60_000)).toBe(31); // the click, then 30 more every 2 s
      expect(await elapse(30 * 60_000)).toBe(31); // stopped
      expect(
        screen.getByText("Nothing yet. Run the command, then check again."),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Check for reviews" }),
      );
      expect(await elapse(0)).toBe(32);
      expect(await elapse(2_000)).toBe(33);
    } finally {
      vi.useRealTimers();
    }
  });
});
