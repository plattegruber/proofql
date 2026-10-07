/**
 * Where the acceptance tests point. `AT_TARGET` picks the environment:
 *
 *   preview  the workers.dev deployment every push to main updates; Clerk's
 *            development instance, sign-up open → the run signs up a fresh
 *            `+clerk_test` user and deletes it afterwards
 *   prod     the custom domains; Clerk's production instance, sign-up
 *            closed → the run signs in the dedicated user `AT_PROD_EMAIL`
 *
 * Every URL can be overridden (`AT_DASHBOARD_URL`, `AT_API_URL`,
 * `AT_CDN_URL`), e.g. to point preview at another workers.dev subdomain.
 * The defaults mirror the wrangler configs: `env.preview` / `env.prod` in
 * apps/dashboard/wrangler.jsonc (API_URL, SNIPPET_SRC), workers/api and
 * workers/cdn (`routes`).
 */

export type TargetName = "preview" | "prod";

export interface Target {
  name: TargetName;
  dashboardUrl: string;
  apiUrl: string;
  cdnUrl: string;
  /** How the run gets a signed-in user. */
  auth: "sign-up" | "sign-in";
  /** The Clerk instance's publishable key (public by design). */
  clerkPublishableKey: string;
}

/** The repository variable WORKERS_SUBDOMAIN (infra/provisioning.md). */
const WORKERS_SUBDOMAIN = process.env.WORKERS_SUBDOMAIN || "gruberplatte";

/**
 * Publishable keys are public (they ship in every dashboard page); these are
 * copied from apps/dashboard/wrangler.jsonc `env.<target>.vars` and must be
 * updated together with it. `CLERK_PUBLISHABLE_KEY` in the environment wins.
 */
const CLERK_PUBLISHABLE_KEYS: Record<TargetName, string> = {
  preview: "pk_test_Y3Jpc3AtZmluY2gtODgxNy5jbGVyay5hY2NvdW50cy5kZXYk",
  prod: "pk_live_Y2xlcmsucHJvb2ZxbC5kZXYk",
};

const DEFAULTS: Record<
  TargetName,
  Pick<Target, "dashboardUrl" | "apiUrl" | "cdnUrl" | "auth">
> = {
  preview: {
    dashboardUrl: `https://proofql-dashboard-preview.${WORKERS_SUBDOMAIN}.workers.dev`,
    apiUrl: `https://proofql-api-preview.${WORKERS_SUBDOMAIN}.workers.dev`,
    cdnUrl: `https://proofql-cdn-preview.${WORKERS_SUBDOMAIN}.workers.dev`,
    auth: "sign-up",
  },
  prod: {
    dashboardUrl: "https://app.proofql.dev",
    apiUrl: "https://api.proofql.dev",
    cdnUrl: "https://cdn.proofql.dev",
    auth: "sign-in",
  },
};

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function resolveTarget(): Target {
  const raw = process.env.AT_TARGET ?? "preview";
  if (raw !== "preview" && raw !== "prod") {
    throw new Error(`AT_TARGET must be "preview" or "prod", got "${raw}"`);
  }
  const d = DEFAULTS[raw];
  return {
    name: raw,
    dashboardUrl: trimSlash(process.env.AT_DASHBOARD_URL || d.dashboardUrl),
    apiUrl: trimSlash(process.env.AT_API_URL || d.apiUrl),
    cdnUrl: trimSlash(process.env.AT_CDN_URL || d.cdnUrl),
    auth: d.auth,
    clerkPublishableKey:
      process.env.CLERK_PUBLISHABLE_KEY || CLERK_PUBLISHABLE_KEYS[raw],
  };
}

export const target = resolveTarget();

/**
 * One id per run, in every name the run creates (user email, workspace,
 * project, review external ids), so leftovers are attributable.
 */
export const runId = (
  process.env.AT_RUN_ID ||
  (process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
    : `local-${Date.now().toString(36)}`)
).toLowerCase();

/** Preview sign-ups: Clerk test addresses never send mail; code 424242. */
export const TEST_EMAIL_PREFIX = "proofql-at-";
export const TEST_EMAIL_PATTERN =
  /^proofql-at-[a-z0-9-]+\+clerk_test@example\.com$/;
export const TEST_VERIFICATION_CODE = "424242";
export const TEST_WORKSPACE_PREFIX = "AT ";

export function previewEmail(): string {
  return `${TEST_EMAIL_PREFIX}${runId}+clerk_test@example.com`;
}

export function prodEmail(): string {
  return process.env.AT_PROD_EMAIL || "acceptance@proofql.dev";
}

/**
 * The origin the snippet test page pretends to be served from. Playwright
 * fulfils requests to it from memory (no DNS, no server), and the run adds
 * it to the project's allowed origins through the dashboard.
 */
export const TEST_PAGE_ORIGIN = "https://acceptance-test.example.com";
