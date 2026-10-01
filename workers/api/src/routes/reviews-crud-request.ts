/**
 * Request shapes for the review CRUD routes (issue #22): the list query
 * string, the opaque pagination cursor, and the PATCH body. Pure zod and
 * encoding, no I/O — unit-tested without a database.
 *
 * Cursor: the list orders by `(occurred_at DESC NULLS LAST, id DESC)` and
 * the cursor is that keyset for the last row of a page, as base64url JSON
 * `{ "o": "<iso datetime>" | null, "i": "<uuid>" }`. It is opaque to clients
 * (the encoding may change) but not secret: a decoded cursor must still
 * pass the schema below, so a tampered or truncated one is a 422, never a
 * database error. Keyset rather than offset so a page is stable while rows
 * are inserted or deleted ahead of it.
 */

import { Buffer } from "node:buffer";

import { REVIEW_SOURCES, reviewInputSchema } from "@proofql/core";
import { z } from "zod";

export const LIST_LIMIT_DEFAULT = 20;
export const LIST_LIMIT_MAX = 100;

/** `?hidden=` — `all` is the default: management APIs show everything. */
export const HIDDEN_FILTERS = ["true", "false", "all"] as const;
export type HiddenFilter = (typeof HIDDEN_FILTERS)[number];

/** Query-string values arrive as strings; coerce and bound them here. */
export const listQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIST_LIMIT_MAX)
    .default(LIST_LIMIT_DEFAULT),
  source: z.enum(REVIEW_SOURCES).optional(),
  min_rating: z.coerce.number().int().min(1).max(5).optional(),
  hidden: z.enum(HIDDEN_FILTERS).default("all"),
  /** `occurred_at >= since`; a full ISO datetime or a bare `YYYY-MM-DD`. */
  since: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
  indexed: z.enum(["true", "false"]).optional(),
});

export type ListQuery = z.output<typeof listQuerySchema>;

/**
 * `PATCH /v1/reviews/:id`. `metadata` replaces the whole map and reuses the
 * ingest schema's shape (flat string→string, same caps) so a value that
 * passes ingest passes here and vice versa.
 */
export const patchBodySchema = z
  .strictObject({
    hidden: z.boolean().optional(),
    metadata: reviewInputSchema.shape.metadata,
  })
  .refine((body) => body.hidden !== undefined || body.metadata !== undefined, {
    message: "Provide at least one of `hidden`, `metadata`.",
  });

export type PatchBody = z.output<typeof patchBodySchema>;

/** The keyset of the last row on a page. */
export interface Cursor {
  /** `occurred_at` as ISO 8601, or null for rows without one (sorted last). */
  o: string | null;
  /** The row id, the tie-breaker. */
  i: string;
}

const cursorSchema = z.strictObject({
  o: z.iso.datetime().nullable(),
  i: z.uuid(),
});

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decode a client-supplied cursor; `null` for anything that is not exactly
 * what `encodeCursor` produces (callers turn that into a 422).
 */
export function decodeCursor(raw: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const result = cursorSchema.safeParse(json);
  return result.success ? result.data : null;
}

/** Keyset for a row, from the columns the list selects. */
export function cursorFor(row: {
  id: string;
  occurredAt: Date | null;
}): Cursor {
  return { o: row.occurredAt?.toISOString() ?? null, i: row.id };
}
