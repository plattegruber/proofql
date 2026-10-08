-- Google Takeout import of a Business Profile's reviews (dashboard, Import →
-- Google Takeout). A new run kind, and a `details` column for the outcome
-- the counts cannot carry: reviews removed because Google no longer has
-- them, Places bootstrap rows replaced, star-only and stale reviews
-- skipped. Nullable, so every existing row and writer is unaffected.
--
-- `ALTER TYPE … ADD VALUE` is allowed inside the migrator's transaction on
-- Postgres 12+; the value is not used in the same transaction (0008).
ALTER TYPE "public"."ingest_run_kind" ADD VALUE 'takeout';--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD COLUMN "details" jsonb;
