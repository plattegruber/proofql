// @vitest-environment happy-dom
// Step 1 through createRoutesStub: one field, the derived address, the
// create + skip forms as separate forms, the plan-limit variant.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub, useActionData, useLoaderData } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import OnboardingProject from "./app.onboarding";

type LoaderData = {
  plan: "free" | "paid";
  quota: { used: number; limit: number; elsewhere: number; atLimit: boolean };
  existing: { name: string; slug: string } | null;
};

const fresh: LoaderData = {
  plan: "free",
  quota: { used: 0, limit: 1, elsewhere: 0, atLimit: false },
  existing: null,
};

function renderStep(
  data: LoaderData,
  action: (args: { request: Request }) => Promise<unknown> = vi.fn(),
) {
  const Stub = createRoutesStub([
    {
      path: "/app/onboarding",
      loader: () => data,
      action: ({ request }) => action({ request }),
      Component: () => (
        <OnboardingProject
          loaderData={useLoaderData() as LoaderData}
          actionData={useActionData() as never}
          params={{}}
          matches={[] as never}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/app/onboarding"]} />);
}

describe("onboarding step 1", () => {
  afterEach(cleanup);

  it("derives the address from the name and posts both", async () => {
    const seen: FormData[] = [];
    renderStep(fresh, async ({ request }) => {
      seen.push(await request.formData());
      return null;
    });
    expect(
      await screen.findByRole("heading", { name: "Name your project" }),
    ).toBeTruthy();
    expect(screen.getByText("Step 1 of 4", { exact: false })).toBeTruthy();

    const input = screen.getByLabelText("Project name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Cedar Ridge Dental" } });
    expect(screen.getByText("/app/projects/cedar-ridge-dental")).toBeTruthy();

    const button = screen.getByRole("button", {
      name: "Create project and keys",
    });
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.get("name")).toBe("Cedar Ridge Dental");
    expect(seen[0]?.get("slug")).toBe("cedar-ridge-dental");
    expect(seen[0]?.get("intent")).toBeNull();
  });

  it("keeps the skip form separate from the create form", async () => {
    renderStep(fresh);
    const skip = await screen.findByRole("button", {
      name: "I'll do this later",
    });
    const create = screen.getByRole("button", {
      name: "Create project and keys",
    });
    expect(skip.closest("form")).not.toBe(create.closest("form"));
    expect(
      skip.closest("form")?.querySelector('input[name="intent"]'),
    ).toHaveProperty("value", "skip");
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("at the plan limit offers to continue with the existing project", async () => {
    const { container } = renderStep({
      plan: "free",
      quota: { used: 1, limit: 1, elsewhere: 0, atLimit: true },
      existing: { name: "Cedar Ridge Dental", slug: "cedar-ridge-dental" },
    });
    expect(
      await screen.findByText("Your plan is at its project limit"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Continue with Cedar Ridge Dental" })
        .getAttribute("href"),
    ).toBe("/app/onboarding/cedar-ridge-dental/reviews");
    expect(screen.queryByLabelText("Project name")).toBeNull();
    expect(container.textContent).not.toContain("!");
  });

  it("explains a free project held in another workspace", async () => {
    const { container } = renderStep({
      plan: "free",
      quota: { used: 0, limit: 1, elsewhere: 1, atLimit: true },
      existing: null,
    });
    expect(
      await screen.findByText("You already have a free project"),
    ).toBeTruthy();
    expect(
      screen.getByText(/one project per person, and you already have one/),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Project name")).toBeNull();
    expect(container.textContent).not.toContain("!");
  });
});
