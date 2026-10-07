/**
 * The dashboard, driven like a customer: through the pages, by visible
 * labels and roles. Selectors follow apps/dashboard/app/routes; Clerk's
 * prebuilt components are matched by their form field names and button
 * labels, which are stable across Clerk's themes.
 */
import { randomBytes } from "node:crypto";

import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, type Page } from "@playwright/test";

import {
  previewEmail,
  prodEmail,
  runId,
  TEST_VERIFICATION_CODE,
  TEST_WORKSPACE_PREFIX,
  target,
} from "./target";

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
  await page.goto(url("/sign-up"));
  await page.locator('input[name="emailAddress"]').fill(email);
  await page.locator('input[name="password"]').fill(throwawayPassword());
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // Email verification: a one-time-code input; Clerk submits on the sixth digit.
  const code = page.locator(
    'input[autocomplete="one-time-code"], input[name="code"]',
  );
  await expect(code.first()).toBeVisible({ timeout: 30_000 });
  await code.first().pressSequentially(TEST_VERIFICATION_CODE, { delay: 50 });

  // Signed up: Clerk redirects to /app, which sends a user with no
  // workspace on to /app/workspace.
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
  return email;
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
  await page.waitForURL(/\/app(\/|$)/);
  return email;
}

/**
 * /app/workspace is where a user with no active Organization lands
 * (requireAccount). A fresh preview user creates one named `AT <run>`; the
 * prod user normally already has one and picks it. Ends on a page inside
 * the protected layout.
 */
export async function ensureWorkspace(page: Page): Promise<void> {
  if (!new URL(page.url()).pathname.startsWith("/app/workspace")) return;
  await expect(
    page.getByRole("heading", { name: "Create your workspace" }),
  ).toBeVisible();

  // An existing membership (prod): Clerk lists it; pick the first one.
  // With no memberships Clerk may open straight on the create form (the
  // name field), or show a "Create organization" button that leads to it.
  const existing = page.locator(".cl-organizationListPreviewButton").first();
  const create = page.getByRole("button", { name: /create organization/i });
  const nameField = page.locator('input[name="name"]');
  await expect(existing.or(create).or(nameField).first()).toBeVisible({
    timeout: 20_000,
  });

  if (await existing.isVisible()) {
    await existing.click();
  } else {
    if (!(await nameField.isVisible())) await create.first().click();
    await nameField.fill(`${TEST_WORKSPACE_PREFIX}${runId}`);
    await page
      .getByRole("button", { name: /create organization/i })
      .last()
      .click();
    // Some Clerk versions follow creation with an "invite members" step.
    const skip = page.getByRole("button", { name: /^skip$/i });
    await Promise.race([
      page.waitForURL((u) => !u.pathname.startsWith("/app/workspace"), {
        timeout: 30_000,
      }),
      skip.click({ timeout: 30_000 }).catch(() => undefined),
    ]);
  }
  await page.waitForURL((u) => !u.pathname.startsWith("/app/workspace"), {
    timeout: 30_000,
  });
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
