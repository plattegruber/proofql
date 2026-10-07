// Site-wide values read at build time. The support address follows the same
// rule as the docs footer (docs/site/src/config.ts): the SUPPORT_EMAIL
// environment variable of the build, else DEFAULT_SUPPORT_EMAIL from
// @proofql/core, so one edit moves every surface.
import { PRIVACY_URL, supportEmailFrom, TERMS_URL } from "@proofql/core";

export const SITE_URL = "https://proofql.dev";
export const SUPPORT_EMAIL = supportEmailFrom(process.env.SUPPORT_EMAIL);

/** Hosts (docs/launch.md §2 "Domains"). */
export const APP_URL = "https://app.proofql.dev";
export const DOCS_URL = "https://docs.proofql.dev";

export const SIGN_UP_URL = `${APP_URL}/sign-up`;
export const SIGN_IN_URL = `${APP_URL}/sign-in`;
/** No pricing page yet: the plan table lives on the docs' Limits page. */
export const PRICING_PAGE_URL = `${DOCS_URL}/limits`;
export const SUBPROCESSORS_URL = `${DOCS_URL}/subprocessors`;

export { PRIVACY_URL, TERMS_URL };
