// Site-wide values the docs read at build time. The support address comes
// from the SUPPORT_EMAIL environment variable of the build (the same name
// the dashboard reads as a var; docs/launch.md "Support"), falling back to
// the placeholder in @proofql/core so one edit moves every surface.
import {
  DEFAULT_SUPPORT_EMAIL,
  ISSUES_URL,
  PRIVACY_URL,
  ROADMAP_URL,
  supportEmailFrom,
  TERMS_URL,
} from "@proofql/core";

export const SUPPORT_EMAIL = supportEmailFrom(process.env.SUPPORT_EMAIL);
export const SUPPORT_EMAIL_IS_PLACEHOLDER =
  SUPPORT_EMAIL === DEFAULT_SUPPORT_EMAIL;

export { ISSUES_URL, PRIVACY_URL, ROADMAP_URL, TERMS_URL };

/** The dashboard's hostname (docs/launch.md "Domains"). */
export const APP_URL = "https://app.proofql.dev";

/** Legal pages are paths on this site; link them relatively so the check passes. */
export const PRIVACY_PATH = new URL(PRIVACY_URL).pathname;
export const TERMS_PATH = new URL(TERMS_URL).pathname;
