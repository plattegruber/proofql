// Queue consumer: deterministic chunking, embeddings, sentiment, cache purge.
// Package constants from the monorepo scaffold (#10); the queue consumer is
// in ./handlers.ts, the per-review indexer in ./index-review.ts, and the
// wrangler entrypoint in ./worker.ts.
import { PACKAGE_NAME as CORE_PACKAGE_NAME } from "@proofql/core";

export const PACKAGE_NAME = "@proofql/pipeline";
export const WORKSPACE_DEPENDENCIES = [
  CORE_PACKAGE_NAME,
  "@proofql/ai",
  "@proofql/db",
] as const;
