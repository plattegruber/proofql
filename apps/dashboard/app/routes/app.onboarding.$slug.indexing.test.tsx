// @vitest-environment happy-dom
// Step 3: the API-path meter reads "Indexing n of m", the import path shows
// the import's own progress, and a settled page offers the snippet.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRoutesStub, useLoaderData } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INDEXING_DELAYED_COPY } from "~/lib/indexing";

import OnboardingIndexing from "./app.onboarding.$slug.indexing";

type LoaderData = Parameters<typeof OnboardingIndexing>[0]["loaderData"];

const base: LoaderData = {
  project: { name: "Cedar Ridge Dental", slug: "cedar" },
  counts: { reviews: 340, indexed: 212, indexing: 128, deferred: false },
  progress: null,
  runHref: null,
  settled: false,
  snippetHref: "/app/onboarding/cedar/snippet",
  reviewsHref: "/app/onboarding/cedar/reviews",
};

function renderStep(data: LoaderData, onLoad: () => void = () => {}) {
  const Stub = createRoutesStub([
    {
      path: "/app/onboarding/:slug/indexing",
      loader: () => {
        onLoad();
        return data;
      },
      Component: () => (
        <OnboardingIndexing
          loaderData={useLoaderData() as LoaderData}
          actionData={undefined}
          params={{ slug: "cedar" }}
          matches={[] as never}
        />
      ),
    },
    {
      path: "/app/onboarding/:slug/snippet",
      Component: () => <h1>Snippet</h1>,
    },
  ]);
  return render(<Stub initialEntries={["/app/onboarding/cedar/indexing"]} />);
}

describe("onboarding step 3", () => {
  afterEach(cleanup);

  it("reads the API-path progress as 'Indexing n of m reviews'", async () => {
    renderStep(base);
    expect(
      await screen.findByRole("heading", {
        name: "Indexing 212 of 340 reviews",
      }),
    ).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Reviews indexed" });
    expect(bar.getAttribute("aria-valuenow")).toBe("212");
    expect(bar.getAttribute("aria-valuemax")).toBe("340");
    expect(screen.getByText(/128 waiting on the pipeline/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Show my snippet" })).toBeNull();
  });

  it("shows the import's own progress after an upload", async () => {
    renderStep({
      ...base,
      progress: {
        status: "succeeded",
        received: 50,
        created: 47,
        updated: 0,
        skipped: 0,
        failed: 3,
        processed: 50,
        indexed: 20,
        indexing: 27,
        deferred: false,
        error: null,
      },
      runHref: "/app/projects/cedar/import/run-1",
    });
    expect(
      await screen.findByRole("region", { name: "Import progress" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Rows processed" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: /Indexing \d+ of/ }),
    ).toBeNull();
  });

  it("when settled, says so and moves on to the snippet", async () => {
    renderStep({
      ...base,
      counts: { reviews: 340, indexed: 340, indexing: 0, deferred: false },
      settled: true,
    });
    expect(
      await screen.findByRole("heading", { name: "Indexed" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Show my snippet" })
        .getAttribute("href"),
    ).toBe("/app/onboarding/cedar/snippet");
    expect(
      await screen.findByRole(
        "heading",
        { name: "Snippet" },
        { timeout: 3_000 },
      ),
    ).toBeTruthy();
  });

  it("API path, deferred: says indexing is delayed and the user can leave, not 'within seconds' (#162)", async () => {
    renderStep({
      ...base,
      counts: { reviews: 340, indexed: 212, indexing: 128, deferred: true },
    });
    expect(await screen.findByText(INDEXING_DELAYED_COPY)).toBeTruthy();
    expect(screen.queryByText(/within seconds/)).toBeNull();
    expect(screen.queryByText(/Usually seconds/)).toBeNull();
    expect(screen.getByText("Delayed")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Go on to the snippet" })
        .getAttribute("href"),
    ).toBe("/app/onboarding/cedar/snippet");
  });

  it("import path, deferred: the import's progress says delayed (#162)", async () => {
    renderStep({
      ...base,
      progress: {
        status: "succeeded",
        received: 5,
        created: 5,
        updated: 0,
        skipped: 0,
        failed: 0,
        processed: 5,
        indexed: 0,
        indexing: 5,
        deferred: true,
        error: null,
      },
      runHref: "/app/projects/cedar/import/run-1",
    });
    expect(await screen.findByText(INDEXING_DELAYED_COPY)).toBeTruthy();
    expect(screen.queryByText(/within seconds/)).toBeNull();
  });

  it("backs off its revalidation and stops after thirty minutes with Check again (#162)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let loads = 0;
      renderStep(base, () => {
        loads += 1;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const initial = loads;
      const elapse = async (ms: number) => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
        return loads - initial;
      };
      expect(await elapse(60_000)).toBe(30); // every 2 s
      expect(await elapse(4 * 60_000)).toBe(54); // then every 10 s
      expect(await elapse(25 * 60_000)).toBe(104); // then every 30 s
      expect(await elapse(60 * 60_000)).toBe(104); // then nothing
      const again = screen.getByRole("button", { name: "Check again" });
      fireEvent.click(again);
      expect(await elapse(0)).toBe(105); // at once
      expect(await elapse(2_000)).toBe(106); // then 2 s later
      expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
