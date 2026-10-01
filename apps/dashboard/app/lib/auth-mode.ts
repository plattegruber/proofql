/**
 * Which authentication the dashboard runs with. Pure: decided from env
 * alone so the rule is unit-testable and greppable.
 *
 *   - "clerk": CLERK_SECRET_KEY is set. Clerk authenticates every request
 *     (app/lib/clerk.server.ts) and a Clerk Organization is the account.
 *   - "stub":  no secret key AND ENVIRONMENT is "local". Every request acts
 *     as the seeded demo account (`pnpm seed`), the shell shows a "Local
 *     auth stub" banner, and /sign-in redirects to /app. Mirrors
 *     Well-Regarded's `requirePracticeContext()` seam: when real auth is
 *     wanted, only `requireAccount` changes behaviour — nothing that calls
 *     it moves.
 *   - "unconfigured": no secret key outside local. Never silently stubbed:
 *     `requireAccount` fails loudly (503) so a preview/prod deploy that is
 *     missing its secret cannot expose the demo account.
 */
export type AuthMode = "clerk" | "stub" | "unconfigured";

export type AuthEnv = Pick<Env, "ENVIRONMENT"> &
  Partial<Pick<Env, "CLERK_SECRET_KEY" | "CLERK_PUBLISHABLE_KEY">>;

export function authMode(env: AuthEnv): AuthMode {
  if (env.CLERK_SECRET_KEY) return "clerk";
  return env.ENVIRONMENT === "local" ? "stub" : "unconfigured";
}
