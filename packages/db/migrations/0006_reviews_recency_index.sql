-- #117: the no-query (recency) statement in searchChunks — "newest `limit`
-- publishable reviews for this tenant" — was a Parallel Seq Scan over every
-- tenant's reviews plus a top-N sort, because no index matched its ORDER BY
-- (`occurred_at DESC NULLS LAST, id`) under the tenant predicate. This btree
-- does; the planner now walks it and stops after `limit` rows (8.2 → 0.8 ms
-- for a 1,000-review tenant in a 45k-row table, docs/performance.md §2).
--
-- `reviews_project_id_environment_idx` is this index's prefix: every query
-- that used it (the search joins, the CRUD and dashboard list routes, the
-- onboarding and import counts) is served by the same leaf pages here, so it
-- is dropped — one fewer btree to maintain per insert. Create first, drop
-- second: the currently deployed workers always have a tenant index to use.
CREATE INDEX "reviews_project_id_environment_occurred_at_idx" ON "reviews" USING btree ("project_id","environment","occurred_at" DESC NULLS LAST,"id");--> statement-breakpoint
DROP INDEX "reviews_project_id_environment_idx";
