/**
 * The Hono app for the api worker — the composition root. Exported
 * separately from the wrangler entrypoint (src/worker.ts) so tests can build
 * one with `createApp({ db })` and drive it with `app.request()` under Node.
 *
 * Middleware order matters: request id first (every response, including
 * errors, carries one), then lazy database access, then routes.
 */

import type { Db } from "@proofql/db";
import { Hono } from "hono";

import type { AppEnv } from "./bindings.js";
import {
  type DbProvider,
  dbMiddleware,
  hyperdriveProvider,
  injectedProvider,
} from "./db.js";
import { notFound, onError } from "./errors.js";
import { requestId } from "./request-id.js";
import { reviewsRoutes } from "./routes/reviews.js";

export interface CreateAppOptions {
  /** Tests: use this client instead of opening one from `env.HYPERDRIVE`. */
  db?: Db;
  /** Full control over how a request obtains its database. */
  dbProvider?: DbProvider;
}

export function createApp(options: CreateAppOptions = {}): Hono<AppEnv> {
  const provider =
    options.dbProvider ??
    (options.db ? injectedProvider(options.db) : hyperdriveProvider);

  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.notFound(notFound);
  app.use(requestId);
  app.use(dbMiddleware(provider));

  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/v1/reviews", reviewsRoutes);

  return app;
}
