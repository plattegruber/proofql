/**
 * The fake Places API (New) moved to `@proofql/google/fake` with #116 so the
 * pipeline's refresh tests share it; this re-export keeps the dashboard's
 * test imports short.
 */
export {
  CEDAR_RIDGE,
  CEDAR_RIDGE_ID,
  FAKE_PLACES,
  type FakePlace,
  type FakePlaceReview,
  type FakePlacesApi,
  fakePlacesApi,
  HARBOR_LIGHT,
  HARBOR_LIGHT_ID,
  QUIET_CORNER,
  QUIET_CORNER_ID,
} from "@proofql/google/fake";
