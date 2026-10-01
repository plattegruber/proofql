/**
 * The Workers runtime inside React Router's loader context.
 *
 * With `v8_middleware` on (react-router.config.ts) `context` in every
 * loader/action/middleware is a `RouterContextProvider`, not a plain
 * object, so the worker entry (workers/app.ts) sets `{ env, ctx }` under
 * this typed key and server code reads it back with `getCloudflare()`.
 *
 * Adding a binding (KV, Hyperdrive, ...) means editing wrangler.jsonc (all
 * three env stanzas) and running `pnpm --filter @proofql/dashboard typegen`
 * to regenerate worker-configuration.d.ts — nothing here changes.
 */
import { createContext, RouterContextProvider } from "react-router";

export interface CloudflareContext {
  env: Env;
  ctx: ExecutionContext;
}

export const cloudflareContext = createContext<CloudflareContext>();

export function getCloudflare(
  context: Readonly<RouterContextProvider>,
): CloudflareContext {
  return context.get(cloudflareContext);
}

/** Build a loader context for tests and scripts. */
export function createLoadContext(
  value: CloudflareContext,
): RouterContextProvider {
  return new RouterContextProvider(new Map([[cloudflareContext, value]]));
}
