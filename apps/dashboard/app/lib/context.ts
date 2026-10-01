/**
 * The Workers runtime inside React Router's loader context.
 *
 * With `v8_middleware` on (react-router.config.ts) `context` in every
 * loader/action/middleware is a `RouterContextProvider`, not a plain
 * object, so the worker entry (workers/app.ts) sets `{ env, ctx, log,
 * requestId }` under this typed key and server code reads it back with
 * `getCloudflare()`.
 *
 * `log` is the request-bound structured logger (#30; @proofql/core
 * `createLogger`, service `dashboard`, bound to `request_id`, `method`,
 * `path`) — the only sanctioned way to log from loaders and actions (Biome
 * bans raw console in apps/*). `requestId` is echoed as `x-request-id`.
 *
 * Adding a binding (KV, Hyperdrive, ...) means editing wrangler.jsonc (all
 * three env stanzas) and running `pnpm --filter @proofql/dashboard typegen`
 * to regenerate worker-configuration.d.ts — nothing here changes.
 */
import { createLogger, type Logger } from "@proofql/core";
import { createContext, RouterContextProvider } from "react-router";

export interface CloudflareContext {
  env: Env;
  ctx: ExecutionContext;
  log: Logger;
  requestId: string;
}

export const cloudflareContext = createContext<CloudflareContext>();

export function getCloudflare(
  context: Readonly<RouterContextProvider>,
): CloudflareContext {
  return context.get(cloudflareContext);
}

/**
 * Build a loader context for tests and scripts. The logger defaults to a
 * silent one so unit tests never write to the console.
 */
export function createLoadContext(
  value: Pick<CloudflareContext, "env" | "ctx"> &
    Partial<Pick<CloudflareContext, "log" | "requestId">>,
): RouterContextProvider {
  const full: CloudflareContext = {
    env: value.env,
    ctx: value.ctx,
    log:
      value.log ??
      createLogger({
        service: "dashboard",
        environment: value.env.ENVIRONMENT ?? "test",
        sink: () => {},
      }),
    requestId: value.requestId ?? "test-request",
  };
  return new RouterContextProvider(new Map([[cloudflareContext, full]]));
}
