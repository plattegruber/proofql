-- #151: the project's business category, a key of CATEGORY_TABLE in
-- @proofql/core (dental, roofing, ...). It picks the generic query words
-- the floor's partial word match ignores. Nullable: null means unknown and
-- gets the universal list only. Filled from Google's primary type on the
-- next Places or Business Profile import, or chosen in Settings.
ALTER TABLE "projects" ADD COLUMN "category" text;--> statement-breakpoint
-- The demo project (DEMO_PROJECT_ID; the seed sets it too) keeps the
-- dental generic words its measured floor numbers rest on
-- (docs/performance.md section 5). No other row is touched.
UPDATE "projects" SET "category" = 'dental' WHERE "id" = 'de300000-0000-4000-8000-000000000002' AND "category" IS NULL;
