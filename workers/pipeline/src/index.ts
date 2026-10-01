// Queue consumer: deterministic chunking, embeddings, sentiment, cache purge.
// Placeholder from the monorepo scaffold (#10). Wrangler config lands in #13.
import { PACKAGE_NAME as CORE_PACKAGE_NAME } from "@proofql/core";

export const PACKAGE_NAME = "@proofql/pipeline";
export const WORKSPACE_DEPENDENCIES = [CORE_PACKAGE_NAME] as const;
