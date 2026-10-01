// Public API on Cloudflare Workers (Hono): /v1/reviews ingest and /v1/query.
// Package constants from the monorepo scaffold (#10); the Hono app is in
// ./app.ts and the wrangler entrypoint in ./worker.ts (#13).
import { PACKAGE_NAME as CORE_PACKAGE_NAME } from "@proofql/core";

export const PACKAGE_NAME = "@proofql/api";
export const WORKSPACE_DEPENDENCIES = [CORE_PACKAGE_NAME] as const;
