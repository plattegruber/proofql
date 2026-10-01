// @vitest-environment happy-dom
// New project through createRoutesStub: the slug follows the name until
// edited; at the plan limit the form gives way to the upgrade message.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub, useActionData, useLoaderData } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import NewProject from "./app.projects.new";

type LoaderData = {
  plan: "free" | "paid";
  quota: { used: number; limit: number; atLimit: boolean };
};

function renderNew(data: LoaderData) {
  const Stub = createRoutesStub([
    {
      path: "/app/projects/new",
      loader: () => data,
      action: vi.fn(),
      Component: () => (
        <NewProject
          loaderData={useLoaderData() as LoaderData}
          actionData={useActionData() as never}
          params={{}}
          matches={[] as never}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/app/projects/new"]} />);
}

describe("new project", () => {
  afterEach(cleanup);

  it("derives the slug from the name until the slug is edited", async () => {
    renderNew({ plan: "paid", quota: { used: 1, limit: 50, atLimit: false } });
    const name = await screen.findByLabelText("Name");
    const slug = screen.getByLabelText("Slug") as HTMLInputElement;

    fireEvent.change(name, { target: { value: "Cedar Ridge Dental" } });
    expect(slug.value).toBe("cedar-ridge-dental");

    fireEvent.change(slug, { target: { value: "cedar" } });
    fireEvent.change(name, { target: { value: "Cedar Ridge Dental & Co" } });
    expect(slug.value).toBe("cedar");
    expect(screen.getByRole("button", { name: "Create project" })).toBeTruthy();
  });

  it("shows the upgrade message instead of the form at the free limit", async () => {
    const { container } = renderNew({
      plan: "free",
      quota: { used: 1, limit: 1, atLimit: true },
    });
    expect(
      await screen.findByText("Your plan is at its project limit"),
    ).toBeTruthy();
    expect(screen.getByText("Free plan")).toBeTruthy();
    expect(screen.getByText(/1 project included; you have 1\./)).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Back to the overview" })
        .getAttribute("href"),
    ).toBe("/app");
    expect(container.textContent).not.toContain("!");
  });
});
