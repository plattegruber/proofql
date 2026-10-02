-- #53: when the guided onboarding was finished or dismissed for an account.
-- Null means a sign-in with zero projects lands on /app/onboarding. On the
-- account rather than in a cookie so the decision follows the user across
-- devices. Nullable, no default, no index — additive only, so the currently
-- deployed workers keep working unchanged.
ALTER TABLE "accounts" ADD COLUMN "onboarding_completed_at" timestamp with time zone;
