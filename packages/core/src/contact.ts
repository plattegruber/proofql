/**
 * Where people reach us and where the legal pages live (docs/launch.md).
 *
 * One module so every surface — the dashboard footer, the docs site footer,
 * the OpenAPI `info` block, error messages — names the same address and the
 * same URLs, and a change is one edit.
 *
 * `DEFAULT_SUPPORT_EMAIL` is the placeholder a deployment shows until the
 * owner sets the `SUPPORT_EMAIL` var on the dashboard (docs/secrets.md) and
 * at build time for the docs site; the mailbox itself is an owner step in
 * docs/launch.md "Support".
 */

/** Shown wherever `SUPPORT_EMAIL` is unset. Must be a real mailbox at launch. */
export const DEFAULT_SUPPORT_EMAIL = "support@proofql.com";

/** The privacy policy and terms pages on the docs site (docs/launch.md "Legal"). */
export const PRIVACY_URL = "https://docs.proofql.com/privacy";
export const TERMS_URL = "https://docs.proofql.com/terms";

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
