/**
 * Pipeline handlers, kept out of the wrangler entrypoint (src/worker.ts) so
 * unit tests can call them under Node with hand-built batches.
 *
 * Skeleton only: the real stages (chunk, embed, sentiment, cache purge)
 * arrive with M1. Nothing here logs — `noConsole` is an error in workers.
 */

import type { IngestMessage } from "./bindings.js";

/** The subset of `MessageBatch` the skeleton touches. */
export type AckableBatch = Pick<
  MessageBatch<IngestMessage>,
  "queue" | "ackAll"
>;

/** Acknowledges every message so nothing retries or dead-letters yet. */
export function handleQueueBatch(batch: AckableBatch): void {
  batch.ackAll();
}

/** `GET /health` → `{ ok: true }`; everything else 404. */
export function handleFetch(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/health") {
    return Response.json({ ok: true });
  }
  return new Response("Not found", { status: 404 });
}
