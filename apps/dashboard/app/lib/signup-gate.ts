/**
 * Is public signup open? Pure: decided from env alone so the rule is
 * unit-testable and greppable (docs/launch.md "Go").
 *
 *   - `SIGNUP_OPEN` set: "true" | "1" | "yes" | "on" (any case) opens
 *     `/sign-up`; every other value closes it. Locally and in preview the
 *     value lives in `vars` of wrangler.jsonc ("true"). In prod it is
 *     deliberately **not** a var: it is set with `wrangler secret put
 *     SIGNUP_OPEN --env prod`, so the launch switch flips without a deploy
 *     and flips back the same way (docs/secrets.md).
 *   - unset: open only when ENVIRONMENT is "local" (a fresh `.dev.vars`
 *     must not hide the real sign-up flow); closed everywhere else, so a
 *     deployed environment that forgot the value fails closed.
 *
 * Closed means `/sign-up` renders the waitlist page (app/routes/sign-up.tsx)
 * and nothing else changes: existing accounts sign in as usual, and the
 * Clerk instance's own "Restricted" sign-up mode is the server-side belt
 * behind this page (docs/launch.md "Clerk production instance").
 */

export interface SignupGateEnv {
  ENVIRONMENT?: string;
  SIGNUP_OPEN?: string;
}

const TRUE_VALUES: ReadonlySet<string> = new Set(["true", "1", "yes", "on"]);

export function signupOpen(env: SignupGateEnv): boolean {
  const raw = env.SIGNUP_OPEN?.trim().toLowerCase();
  if (raw === undefined || raw === "") return env.ENVIRONMENT === "local";
  return TRUE_VALUES.has(raw);
}
