/**
 * The Hono app for the api worker, exported separately from the wrangler
 * entrypoint (src/worker.ts) so tests can drive it with `app.request()`
 * under Node.
 *
 * Deliberately minimal: `GET /health` only. /v1/reviews and /v1/query land
 * with M1.
 */

import { Hono } from "hono";

import type { AppEnv } from "./bindings.js";

export const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ ok: true }));
