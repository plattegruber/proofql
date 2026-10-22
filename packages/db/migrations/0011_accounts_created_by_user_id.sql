-- The Clerk user who created each account's Organization, so the dashboard
-- applies the free plan's project allowance per person instead of per
-- workspace (docs/go-live.md "Free-tier multiplication"). Nullable, no
-- default, no backfill: null means "not counted". Additive only, so the
-- currently deployed workers keep working unchanged. The index is built on
-- a table of a few rows, so a plain CREATE INDEX holds its lock for
-- milliseconds.
ALTER TABLE "accounts" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
CREATE INDEX "accounts_created_by_user_id_idx" ON "accounts" USING btree ("created_by_user_id");