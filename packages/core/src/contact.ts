/**
 * Where people reach us and where the legal pages live (docs/launch.md).
 *
 * One module so every surface — the dashboard footer, the docs site footer,
 * the OpenAPI `info` block, error messages — names the same address and the
 * same URLs, and a change is one edit.
 *
 * `DEFAULT_SUPPORT_EMAIL` is the support address on the `proofql.dev` zone
 * (Cloudflare Email Routing; the owner steps are docs/launch.md "Support").
 * The dashboard's `SUPPORT_EMAIL` var and the docs build's `SUPPORT_EMAIL`
 * override it (docs/secrets.md).
 */

/** Shown wherever `SUPPORT_EMAIL` is unset. A real inbox once Email Routing is on. */
export const DEFAULT_SUPPORT_EMAIL = "support@proofql.dev";

/** The privacy policy and terms pages on the docs site (docs/launch.md "Legal"). */
export const PRIVACY_URL = "https://docs.proofql.dev/privacy";
export const TERMS_URL = "https://docs.proofql.dev/terms";

/** Public roadmap and status: the GitHub issues (the repository is public). */
export const ROADMAP_URL = "https://github.com/plattegruber/proofql/issues/52";
export const ISSUES_URL = "https://github.com/plattegruber/proofql/issues";

/**
 * Resolve the support address from an env value: a trimmed non-empty
 * string wins, anything else falls back to the default. Pure so the
 * dashboard and the docs build share the rule.
 */
export function supportEmailFrom(value: string | undefined | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_SUPPORT_EMAIL;
}
