/**
 * The dashboard, driven like a customer: through the pages, by visible
 * labels and roles. Selectors follow apps/dashboard/app/routes; Clerk's
 * prebuilt components are matched by their form field names and button
 * labels, which are stable across Clerk's themes.
 */
import { randomBytes } from "node:crypto";

import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, type Page } from "@playwright/test";

import { clerkSignUpMode, invitationLink } from "./clerk-admin";
import {
  previewEmail,
  prodEmail,
  runId,
  TEST_VERIFICATION_CODE,
  TEST_WORKSPACE_PREFIX,
  target,
} from "./target";
import { recordWarning } from "./warnings";

const url = (path: string) => `${target.dashboardUrl}${path}`;

/** A password nobody needs to know: generated per run, never logged. */
function throwawayPassword(): string {
  return `At-${randomBytes(18).toString("base64url")}-9`;
}

/**
 * Preview: sign up a fresh user through /sign-up (Clerk's <SignUp/>). The
 * address is a Clerk test address, so no mail is sent and the code is
 * always 424242. The testing token (clerkSetup in global-setup.ts) lets the
 * run past Clerk's bot protection.
 */
export async function signUp(page: Page): Promise<string> {
  const email = previewEmail();
  await setupClerkTestingToken({ page });

  // Preview is meant to have open sign-up (SIGNUP_OPEN=true, Clerk mode
  // "public"). If the Clerk instance has drifted to "restricted", <SignUp/>
  // renders nothing for an uninvited visitor; test the invited path instead
  // and say so loudly (a warning annotation and the job summary).
  const mode = await clerkSignUpMode(target.clerkPublishableKey);
  if (mode === "public") {
    await page.goto(url("/sign-up"));
    await page.locator('input[name="emailAddress"]').fill(email);
  } else if (mode === "restricted") {
    recordWarning(
      "Clerk dev sign-up mode is restricted; tested the invitation path, not open sign-up",
    );
    await page.goto(await invitationLink(email, url("/sign-up")));
    await page.waitForURL(/\/sign-up\?.*__clerk_ticket=/);
  } else {
    throw new Error(`Clerk sign-up mode is "${mode}"; preview needs "public"`);
  }
  await page.locator('input[name="password"]').fill(throwawayPassword());
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // Email verification (open sign-up only; an invitation ticket already
  // proves the address): a one-time-code input, submitted on the sixth digit.
  if (mode === "public") {
    const code = page.locator(
      'input[autocomplete="one-time-code"], input[name="code"]',
    );
    await expect(code.first()).toBeVisible({ timeout: 30_000 });
    await code.first().pressSequentially(TEST_VERIFICATION_CODE, {
      delay: 50,
    });
  }

  // Signed up: Clerk redirects to /app (which sends a user with no
  // workspace on to /app/workspace), or, when the instance requires an
  // organization, first to its choose-organization task.
  await page.waitForURL(isPastAuth, { timeout: 30_000 });
  return email;
}

/** Signed in: inside the app, or on a Clerk session task (`…/tasks/…`). */
function isPastAuth(u: URL): boolean {
  return /^\/app(\/|$)/.test(u.pathname) || u.pathname.includes("/tasks/");
}

function isWorkspaceStep(u: URL): boolean {
  return (
    u.pathname.startsWith("/app/workspace") || u.pathname.includes("/tasks/")
  );
}

/**
 * Prod: sign in the dedicated acceptance user with a sign-in token minted
 * through the Backend API (`clerk.signIn` with `emailAddress`). Code
 * strategies only work on development instances; this works on both.
 */
export async function signIn(page: Page): Promise<string> {
  const email = prodEmail();
  await page.goto(url("/sign-in"));
  await clerk.signIn({ page, emailAddress: email });
  await page.goto(url("/app"));
  await page.waitForURL(isPastAuth);
  return email;
}

/**
 * Getting a workspace (a Clerk Organization). Two places can ask for one:
 * the app's own /app/workspace (requireAccount sends a user with no active
 * Organization there) and, on an instance that requires organizations,
 * Clerk's `choose-organization` session task (`/sign-in/tasks/…` or
 * `/sign-up/tasks/…`, rendered by <SignIn/> / <SignUp/>; a pending session
 * counts as signed out on the server, so /app bounces there). Both show
 * Clerk's organization list or create form. A fresh preview user creates
 * `AT <run>`; the prod user normally has one already and picks it. Ends
 * inside the protected layout.
 */
export async function ensureWorkspace(page: Page): Promise<void> {
  // A pending session lands on /sign-in first; <SignIn/> moves it on to the
  // task client-side. Stuck on /sign-in here means a user cannot get in.
  await page.waitForURL(isPastAuth, { timeout: 30_000 });
  for (let round = 0; round < 2; round++) {
    if (!isWorkspaceStep(new URL(page.url()))) break;
    await createOrPickWorkspace(page);
    await page.waitForURL((u) => !isWorkspaceStep(u), { timeout: 30_000 });
    // The task may hand over to /app, which may still want /app/workspace
    // (no active organization yet) — the loop's second round.
    await page.waitForLoadState();
  }
  await expect(page).toHaveURL(/\/app(\/|$)/);
  await expect(page).not.toHaveURL(/\/app\/workspace/);
}

async function createOrPickWorkspace(page: Page): Promise<void> {
  // An existing membership (prod): Clerk lists it; pick the first one.
  // With no memberships Clerk may open straight on the create form (the
  // name field), or show a "Create organization" button that leads to it.
  const existing = page
    .locator(
      '[class*="organizationListPreviewButton"], [class*="PreviewButton"]',
    )
    .first();
  const create = page.getByRole("button", {
    name: /create (new )?organization/i,
  });
  const nameField = page.locator('input[name="name"]');
  await expect(existing.or(create.first()).or(nameField).first()).toBeVisible({
    timeout: 20_000,
  });

  if (await existing.isVisible()) {
    await existing.click();
    return;
  }
  if (!(await nameField.isVisible())) await create.first().click();
  await nameField.fill(`${TEST_WORKSPACE_PREFIX}${runId}`);
  // Clerk's create call, so a refusal fails here with Clerk's own reason
  // (error codes and messages only; nothing in them is a credential).
  const created = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /\/v1\/organizations(\?|$)/.test(r.url()),
    { timeout: 30_000 },
  );
  // Submit the form whatever its button says ("Create organization",
  // "Continue").
  await nameField.press("Enter");
  const res = await created;
  if (!res.ok()) {
    const body = (await res.json().catch(() => null)) as {
      errors?: { code?: string; message?: string; long_message?: string }[];
    } | null;
    const reasons = (body?.errors ?? [])
      .map((e) => `${e.code}: ${e.long_message ?? e.message}`)
      .join("; ");
    throw new Error(
      `Clerk refused to create the organization (HTTP ${res.status()}): ${reasons || "no details"}`,
    );
  }
  // Some Clerk versions follow creation with an "invite members" step.
  const skip = page.getByRole("button", { name: /^skip$/i });
  await Promise.race([
    page.waitForURL((u) => !isWorkspaceStep(u), { timeout: 30_000 }),
    skip.click({ timeout: 30_000 }).catch(() => undefined),
  ]);
}

/**
 * Every project the signed-in account has, by slug, read from the overview.
 * An account with no projects whose onboarding is unfinished is redirected
 * to /app/onboarding instead (app._index.tsx), which means "none".
 */
export async function listProjectSlugs(page: Page): Promise<string[]> {
  await page.goto(url("/app"));
  if (new URL(page.url()).pathname.startsWith("/app/onboarding")) return [];
  await expect(page.getByRole("main")).toBeVisible();
  const hrefs = await page
    .locator('a[href^="/app/projects/"]')
    .evaluateAll((links) => links.map((a) => a.getAttribute("href") ?? ""));
  const slugs = new Set<string>();
  for (const href of hrefs) {
    const slug = /^\/app\/projects\/([^/?#]+)/.exec(href)?.[1];
    if (slug && slug !== "new") slugs.add(slug);
  }
  return [...slugs];
}

/** Settings → Danger → Delete project, typing the slug to confirm. */
export async function deleteProject(page: Page, slug: string): Promise<void> {
  await page.goto(url(`/app/projects/${slug}/settings`));
  await page.getByRole("button", { name: "Delete project" }).click();
  await page.getByLabel(`Type ${slug}`).fill(slug);
  await page.getByRole("button", { name: "Delete project" }).click();
  await page.waitForURL((u) => !u.pathname.includes(`/projects/${slug}`), {
    timeout: 30_000,
  });
}

/**
 * Onboarding step 1: name the project. Creates the project, its first two
 * live keys and an allowed origin for the dashboard's own preview. Returns
 * the slug the dashboard derived.
 */
export async function createProjectViaOnboarding(
  page: Page,
  name: string,
): Promise<string> {
  await page.goto(url("/app/onboarding"));
  await expect(
    page.getByRole("heading", { name: "Name your project" }),
  ).toBeVisible();
  await page.getByLabel("Project name").fill(name);
  await page.getByRole("button", { name: "Create project and keys" }).click();
  await page.waitForURL(/\/app\/onboarding\/[^/]+\/reviews$/);
  await expect(
    page.getByRole("heading", { name: "Add your reviews" }),
  ).toBeVisible();
  const slug = /\/app\/onboarding\/([^/]+)\/reviews$/.exec(page.url())?.[1];
  if (!slug) throw new Error(`no slug in ${page.url()}`);
  return slug;
}

/** Keys → Create a key. Returns the plaintext the reveal panel shows once. */
export async function createKey(
  page: Page,
  slug: string,
  kind: "secret" | "publishable",
): Promise<string> {
  const keysPath = `/app/projects/${slug}/keys`;
  if (!page.url().endsWith(keysPath)) await page.goto(url(keysPath));
  const form = page.getByRole("form", { name: "Create a key" });
  await form.getByLabel("Kind").selectOption(kind);
  await form.getByLabel("Environment").selectOption("live");
  await form.getByRole("button", { name: "Create key" }).click();
  const plaintext = page.getByTestId("plaintext-key");
  await expect(plaintext).toBeVisible();
  const key = (await plaintext.textContent())?.trim() ?? "";
  const prefix = kind === "secret" ? "pq_sk_live_" : "pq_pk_live_";
  if (!key.startsWith(prefix)) {
    throw new Error(`the new ${kind} key does not start with ${prefix}`);
  }
  await page.getByRole("button", { name: "Done" }).click();
  await expect(plaintext).toBeHidden();
  return key;
}

/** Keys → Allowed origins → Add origin. */
export async function addAllowedOrigin(
  page: Page,
  slug: string,
  origin: string,
): Promise<void> {
  const keysPath = `/app/projects/${slug}/keys`;
  if (!page.url().endsWith(keysPath)) await page.goto(url(keysPath));
  const form = page.getByRole("form", { name: "Add an origin" });
  await form.getByLabel("Add origin").fill(origin);
  await form.getByRole("button", { name: "Add origin" }).click();
  await expect(
    page.getByRole("listitem").filter({ hasText: origin }),
  ).toBeVisible();
}

export { url as dashboardUrl };
