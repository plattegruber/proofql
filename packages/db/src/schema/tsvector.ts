/**
 * Postgres `tsvector`, which drizzle-orm has no built-in column type for.
 *
 * Only ever written by Postgres itself (a stored generated column on
 * `review_chunks.tsv`, indexed with GIN); the `string` data type exists so
 * the row type is complete. Application code never writes it and reads it
 * only in hand-written full-text SQL.
 */

import { customType } from "drizzle-orm/pg-core";

export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
