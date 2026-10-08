// @proofql/db/seed — the demo dataset (#20): runSeed for integration tests
// and scripts, the fixture list and constants for anything that needs to
// know what the demo project contains (the playground, relevance tests).

export {
  DEMO_ACCOUNT_CLERK_ORG_ID,
  DEMO_ACCOUNT_ID,
  DEMO_ACCOUNT_NAME,
  DEMO_ALLOWED_ORIGINS,
  DEMO_PROJECT_CATEGORY,
  DEMO_PROJECT_ID,
  DEMO_PROJECT_NAME,
  DEMO_PROJECT_SLUG,
  LOCAL_DATABASE_URL,
  occurredAtFor,
  SEED_ANCHOR,
  SEED_VERSION,
} from "./constants.js";
export {
  DEMO_DEFAULT_LANGUAGE,
  DEMO_LIVE_REVIEWS,
  DEMO_REVIEW_FIXTURES,
  DEMO_TEST_REVIEWS,
  type DemoLocation,
  type DemoReviewFixture,
  demoExternalId,
  demoLanguage,
} from "./fixtures/reviews.js";
export { assertSeedTargetAllowed, SeedGuardError } from "./guard.js";
export {
  demoAccountName,
  type RunSeedOptions,
  runSeed,
  type SeedKey,
  type SeedSummary,
} from "./run.js";
