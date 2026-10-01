/**
 * Query embedding for the api worker, resolved per request like the
 * database (src/db.ts): `/v1/query` embeds `q` with Workers AI bge-m3 —
 * the same model the pipeline indexed the chunks with, which is what makes
 * the cosine comparison meaningful.
 *
 * `env.AI` is bound in preview/prod only (infra/environments.md): there is
 * no local simulator. Locally the deterministic fake stands in so
 * `wrangler dev` exercises the whole search path. Anywhere else a missing
 * binding is a deployment bug and surfaces as 503 `embedding_unavailable`
 * on the first query that needs it — never as fake vectors silently scoring
 * real reviews.
 *
 * Tests: `createApp({ embedder })` injects the fake (with `shouldFail` for
 * the 503 path).
 */

import {
  createWorkersAiEmbedder,
  type EmbeddingProvider,
  FakeEmbeddingProvider,
} from "@proofql/ai";
import { createMiddleware } from "hono/factory";

import type { ApiBindings, AppEnv } from "./bindings.js";

/** How the app obtains an embedder for a request. */
export type EmbedderProvider = (env: ApiBindings) => EmbeddingProvider;

/** The real thing in preview/prod; the fake under `wrangler dev`. */
export const workersAiEmbedder: EmbedderProvider = (env) => {
  if (env.AI) return createWorkersAiEmbedder(env.AI);
  if (env.ENVIRONMENT === "local") return new FakeEmbeddingProvider();
  throw new Error(
    `AI binding is not bound in environment "${env.ENVIRONMENT}" — add it to wrangler.jsonc (infra/environments.md)`,
  );
};

/** For tests: always the given provider. */
export function injectedEmbedder(
  embedder: EmbeddingProvider,
): EmbedderProvider {
  return () => embedder;
}

/** Installs `c.get("getEmbedder")`; resolves lazily, once per request. */
export function embedderMiddleware(provider: EmbedderProvider) {
  return createMiddleware<AppEnv>(async (c, next) => {
    let embedder: EmbeddingProvider | undefined;
    c.set("getEmbedder", () => {
      embedder ??= provider(c.env);
      return embedder;
    });
    await next();
  });
}
