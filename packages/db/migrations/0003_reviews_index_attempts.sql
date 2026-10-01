-- #72: the pipeline's re-enqueue sweep puts reviews stuck with
-- indexed_at IS NULL back on the queue every five minutes; index_attempts
-- counts those re-sends so the sweep can stop at five, and the partial index
-- keeps the "unindexed, oldest first" scan narrow as reviews grows.
-- Additive only, so the currently deployed workers keep working unchanged.
ALTER TABLE "reviews" ADD COLUMN "index_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "reviews_unindexed_updated_at_idx" ON "reviews" USING btree ("updated_at") WHERE "reviews"."indexed_at" IS NULL;