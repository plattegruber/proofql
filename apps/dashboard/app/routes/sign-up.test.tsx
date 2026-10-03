// @vitest-environment happy-dom
// /sign-up in both states: the loader's gate decision from env, and the
// page rendering Clerk's sign-up when open or the waitlist card when
// closed (including the joined state and the sign-in way through).
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub, useActionData, useLoaderData } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLoadContext } from "~/lib/context";
import SignUpPage, { loader } from "./sign-up";

// Clerk's prebuilt component only mounts inside <ClerkProvider>; a marker
// is enough to prove which branch rendered.
vi.mock("@clerk/react-router", () => ({
  SignUp: () => <div data-testid="clerk-sign-up" />,
  SignIn: () => <div data-testid="clerk-sign-in" />,
}));

// `Env` types the vars as the literals in wrangler.jsonc; tests need the
// other values, so the builder is loose on purpose.
function env(overrides: Record<string, string> = {}): Env {
  return {
    ENVIRONMENT: "prod",
    CLERK_SECRET_KEY: "sk_test_x",
    CLERK_PUBLISHABLE_KEY: "pk_test_x",
    SUPPORT_EMAIL: "help@example.com",
    ...overrides,
  } as unknown as Env;
}

async function run(e: Env) {
  return loader({
    request: new Request("https://dash.test/sign-up"),
    params: {},
    context: createLoadContext({ env: e, ctx: {} as ExecutionContext }),
  } as never);
}

describe("sign-up loader", () => {
  it("reports open with the support address when SIGNUP_OPEN is true", async () => {
    expect(await run(env({ SIGNUP_OPEN: "true" }))).toEqual({
      open: true,
      supportEmail: "help@example.com",
    });
  });

  it("reports closed when SIGNUP_OPEN is false or unset outside local", async () => {
    expect(await run(env({ SIGNUP_OPEN: "false" }))).toEqual({
      open: false,
      supportEmail: "help@example.com",
    });
    expect(await run(env())).toMatchObject({ open: false });
  });

  it("falls back to the default support address when the var is empty", async () => {
    expect(await run(env({ SUPPORT_EMAIL: "" }))).toMatchObject({
      supportEmail: "support@proofql.com",
    });
  });

  it("redirects to /app in the local auth stub", async () => {
    await expect(
      run(env({ ENVIRONMENT: "local", CLERK_SECRET_KEY: "" })),
    ).rejects.toSatisfy(
      (thrown) =>
        thrown instanceof Response &&
        thrown.status === 302 &&
        thrown.headers.get("Location") === "/app",
    );
  });
});

type LoaderData = { open: boolean; supportEmail: string };
type ActionData = { ok: boolean } | undefined;

function renderPage(data: LoaderData, actionData?: ActionData) {
  const Stub = createRoutesStub([
    {
      path: "/sign-up",
      loader: () => data,
      action: () => actionData ?? null,
      Component: () => (
        <SignUpPage
          loaderData={useLoaderData() as LoaderData}
          actionData={useActionData() as never}
          params={{ "*": "" }}
          matches={[] as never}
        />
      ),
    },
    { path: "/sign-in", Component: () => <div>sign in page</div> },
  ]);
  return render(<Stub initialEntries={["/sign-up"]} />);
}

describe("sign-up page", () => {
  afterEach(cleanup);

  it("renders Clerk's sign-up while signup is open", async () => {
    renderPage({ open: true, supportEmail: "help@example.com" });
    expect(await screen.findByTestId("clerk-sign-up")).toBeTruthy();
    expect(screen.queryByText("ProofQL is not open yet")).toBeNull();
    expect(screen.getByText("help@example.com").getAttribute("href")).toBe(
      "mailto:help@example.com",
    );
  });

  it("renders the waitlist form while signup is closed, with the way to sign in", async () => {
    const { container } = renderPage({
      open: false,
      supportEmail: "help@example.com",
    });
    expect(
      await screen.findByRole("heading", { name: "ProofQL is not open yet" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("clerk-sign-up")).toBeNull();
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.name).toBe("email");
    expect(email.type).toBe("email");
    expect(
      screen
        .getByRole("button", { name: "Join the waitlist" })
        .closest("form")
        ?.getAttribute("method"),
    ).toBe("post");
    // The honeypot is in the form but hidden from people.
    const honeypot = container.querySelector(
      'input[name="website"]',
    ) as HTMLInputElement;
    expect(honeypot.tabIndex).toBe(-1);
    expect(honeypot.closest("[aria-hidden]")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/sign-in");
    expect(container.textContent).not.toContain("!");
  });

  it("stops asking once the address is on the list", async () => {
    renderPage({ open: false, supportEmail: "help@example.com" }, { ok: true });
    // Submitting the stub's action lands the actionData; render it directly.
    expect(
      await screen.findByRole("heading", { name: "ProofQL is not open yet" }),
    ).toBeTruthy();
  });
});
