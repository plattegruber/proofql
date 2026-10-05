-- #138: re-tune the default relevance floor on real bge-m3 embeddings.
-- 0.55 was chosen against the deterministic fake embedder; with bge-m3,
-- unrelated in-domain sentences score 0.55-0.65 against dental reviews, so
-- "empty beats irrelevant" did not hold. The labelled fixture run
-- (docs/floor-tuning/2026-10-05.json, `pnpm db:tune-floor`) puts the
-- lowest floor with no false positives on must-be-empty queries at 0.66.
-- The value mirrors DEFAULT_SIMILARITY_FLOOR in @proofql/core.
ALTER TABLE "projects" ALTER COLUMN "similarity_floor" SET DEFAULT 0.66;--> statement-breakpoint
-- Projects still on the old default move with it; a project whose owner
-- chose any other value in Settings keeps it (per-project tuning stays).
UPDATE "projects" SET "similarity_floor" = 0.66 WHERE "similarity_floor" = 0.55;
