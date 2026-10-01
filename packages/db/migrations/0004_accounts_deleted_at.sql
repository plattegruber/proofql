-- #36: the dashboard's Clerk webhook marks an account whose Organization was
-- deleted in Clerk instead of deleting the row (which would cascade through
-- every project, key, review and chunk). Nullable, no default, no index —
-- additive only, so the currently deployed workers keep working unchanged.
ALTER TABLE "accounts" ADD COLUMN "deleted_at" timestamp with time zone;