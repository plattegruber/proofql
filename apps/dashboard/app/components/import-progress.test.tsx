// @vitest-environment happy-dom
// The import progress view (#162): the backoff schedule of the polling
// hook under fake timers, the "Check again" stop, and the copy while
// indexing is deferred.
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INDEXING_DELAYED_COPY } from "~/lib/indexing";
import {
  ImportProgress,
  type ImportProgressData,
  PollingStopped,
  useBackoffPolling,
} from "./import-progress";

const SEC = 1_000;
const MIN = 60 * SEC;

describe("useBackoffPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  it("polls every 2 s for a minute, every 10 s to five minutes, every 30 s to thirty, then stops", () => {
    const poll = vi.fn();
    const { result } = renderHook(() => useBackoffPolling(true, poll));

    advance(2 * SEC - 1);
    expect(poll).toHaveBeenCalledTimes(0);
    advance(1);
    expect(poll).toHaveBeenCalledTimes(1);
    advance(MIN - 2 * SEC);
    expect(poll).toHaveBeenCalledTimes(30); // 2 s … 60 s

    advance(10 * SEC);
    expect(poll).toHaveBeenCalledTimes(31); // 70 s
    advance(4 * MIN - 10 * SEC);
    expect(poll).toHaveBeenCalledTimes(54); // every 10 s to 5 min

    advance(30 * SEC);
    expect(poll).toHaveBeenCalledTimes(55);
    advance(25 * MIN - 30 * SEC);
    expect(poll).toHaveBeenCalledTimes(104); // every 30 s to 30 min
    expect(result.current.stopped).toBe(true);

    advance(2 * 60 * MIN);
    expect(poll).toHaveBeenCalledTimes(104);
  });

  it("Check again polls at once and restarts the schedule from 2 s", () => {
    const poll = vi.fn();
    const { result } = renderHook(() => useBackoffPolling(true, poll));
    advance(31 * MIN);
    expect(result.current.stopped).toBe(true);
    const before = poll.mock.calls.length;

    act(() => result.current.checkAgain());
    expect(poll).toHaveBeenCalledTimes(before + 1);
    expect(result.current.stopped).toBe(false);
    advance(2 * SEC);
    expect(poll).toHaveBeenCalledTimes(before + 2);
  });

  it("does nothing while inactive and stops when it turns inactive", () => {
    const poll = vi.fn();
    const { result, rerender } = renderHook(
      ({ active }) => useBackoffPolling(active, poll),
      { initialProps: { active: false } },
    );
    advance(10 * MIN);
    expect(poll).not.toHaveBeenCalled();
    expect(result.current.stopped).toBe(false);

    rerender({ active: true });
    advance(4 * SEC);
    expect(poll).toHaveBeenCalledTimes(2);
    rerender({ active: false });
    advance(10 * MIN);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(result.current.stopped).toBe(false);
  });

  it("calls the latest poll function, not the first render's", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ poll }) => useBackoffPolling(true, poll),
      { initialProps: { poll: first } },
    );
    rerender({ poll: second });
    advance(2 * SEC);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("PollingStopped", () => {
  afterEach(cleanup);

  it("renders nothing while polling, and a Check again button once stopped", () => {
    const checkAgain = vi.fn();
    const { rerender } = render(
      <PollingStopped polling={{ stopped: false, checkAgain }} />,
    );
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    rerender(<PollingStopped polling={{ stopped: true, checkAgain }} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(checkAgain).toHaveBeenCalledTimes(1);
  });
});

describe("ImportProgress copy", () => {
  afterEach(cleanup);

  const progress: ImportProgressData = {
    status: "succeeded",
    received: 250,
    created: 250,
    updated: 0,
    skipped: 0,
    failed: 0,
    processed: 250,
    indexed: 0,
    indexing: 250,
    deferred: false,
    error: null,
  };

  it("says seconds while indexing normally", () => {
    render(<ImportProgress progress={progress} />);
    expect(
      screen.getByText(
        "250 waiting on the pipeline — searchable within seconds.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Indexing")).toBeTruthy();
  });

  it("says delayed, never seconds, while indexing is deferred", () => {
    render(<ImportProgress progress={{ ...progress, deferred: true }} />);
    expect(screen.getByText(INDEXING_DELAYED_COPY)).toBeTruthy();
    expect(screen.queryByText(/within seconds/)).toBeNull();
    expect(screen.getByText("Delayed")).toBeTruthy();
  });
});
