// @vitest-environment happy-dom
// Settings tab through createRoutesStub: the form carries the project's
// current policy, validation errors from the action render under their
// fields (one message each, aria-wired), and deleting needs the slug typed.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  createRoutesStub,
  data,
  useActionData,
  useLoaderData,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProjectSettings, {
  type SettingsActionData,
} from "./app.projects.$slug.settings";

const loaderData = {
  project: {
    name: "Cedar Ridge Dental",
    slug: "cedar-ridge-dental",
    minRating: 4,
    similarityFloor: 0.66,
    reviewCount: 80,
  },
};

function renderSettings(action: () => Promise<unknown>) {
  const Stub = createRoutesStub([
    {
      path: "/app/projects/:slug/settings",
      loader: () => loaderData,
      action,
      Component: () => (
        <ProjectSettings
          loaderData={useLoaderData() as typeof loaderData}
          actionData={useActionData() as SettingsActionData | undefined}
          params={{ slug: "cedar-ridge-dental" }}
          matches={[] as never}
        />
      ),
    },
  ]);
  return render(
    <Stub initialEntries={["/app/projects/cedar-ridge-dental/settings"]} />,
  );
}

describe("settings tab", () => {
  afterEach(cleanup);

  it("shows the current policy with its helper text and the docs link", async () => {
    const { container } = renderSettings(vi.fn());
    const minRating = (await screen.findByLabelText(
      "Minimum rating",
    )) as unknown as HTMLSelectElement;
    expect(minRating.value).toBe("4");
    const floor = screen.getByLabelText("Similarity floor") as HTMLInputElement;
    expect(floor.value).toBe("0.66");
    expect(floor.getAttribute("min")).toBe("0.3");
    expect(floor.getAttribute("max")).toBe("0.9");
    expect(floor.getAttribute("step")).toBe("0.01");
    expect(
      screen.getByText(
        "Reviews rated below this never appear in query results.",
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "how relevance is scored" })
        .getAttribute("href"),
    ).toMatch(/#relevance$/);
    // The helper text quotes the measured default (#138), not a stale one.
    expect(container.textContent).toContain("The default of 0.66");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Cedar Ridge Dental",
    );
    expect(container.textContent).not.toContain("!");
  });

  it("renders the action's field errors under their fields", async () => {
    const action = vi.fn(async () =>
      data(
        {
          fieldErrors: {
            similarity_floor: ["Enter a value between 0.3 and 0.9."],
            slug: ["Another project in this account already uses this slug."],
          },
        },
        { status: 422 },
      ),
    );
    renderSettings(action);
    await screen.findByLabelText("Similarity floor");

    // happy-dom does not implicitly submit a <form> from a button click.
    const form = screen
      .getByRole("button", { name: "Save settings" })
      .closest("form");
    if (!form) throw new Error("save form not found");
    fireEvent.submit(form);

    const message = await screen.findByText(
      "Enter a value between 0.3 and 0.9.",
    );
    const floor = screen.getByLabelText("Similarity floor");
    expect(floor.getAttribute("aria-invalid")).toBe("true");
    expect(floor.getAttribute("aria-describedby")).toBe(message.id);
    expect(
      screen.getByText(
        "Another project in this account already uses this slug.",
      ),
    ).toBeTruthy();
    // Untouched fields keep their hints, not an error.
    expect(
      screen.getByLabelText("Minimum rating").getAttribute("aria-invalid"),
    ).toBeNull();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("arms the delete button only once the slug is typed", async () => {
    renderSettings(vi.fn());
    await screen.findByLabelText("Similarity floor");

    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
    const confirm = screen.getByRole("button", { name: "Delete project" });
    expect(confirm).toHaveProperty("disabled", true);

    const input = screen.getByLabelText("Type cedar-ridge-dental");
    fireEvent.change(input, { target: { value: "cedar-ridge" } });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "cedar-ridge-dental" } });
    expect(confirm).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Type cedar-ridge-dental")).toBeNull();
  });
});
