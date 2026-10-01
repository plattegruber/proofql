/**
 * `usage` — per-project monthly query counters for free-tier limits and,
 * later, metered billing (scope.md §2 "Free tier", §4).
 *
 * One row per `(project_id, month)`, where `month` is the first day of the
 * calendar month (UTC). `queries` counts every query the API answered;
 * `cache_hits` counts the ones served from KV, which the free tier does not
 * charge against the limit — so the enforced number is
 * `queries - cache_hits`. Both are incremented with `INSERT ... ON CONFLICT
 * DO UPDATE SET x = x + 1`, never read-modify-write.
 *
 * Usage is per project, not per environment: test keys are rate-limited
 * like live ones and count toward the same monthly limit, which is what
 * keeps a test key from being a free second quota.
 */

import { date, integer, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";

import { projects } from "./tenancy.js";

export const usage = pgTable(
  "usage",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** First day of the month, UTC. */
    month: date("month").notNull(),
    queries: integer("queries").notNull().default(0),
    cacheHits: integer("cache_hits").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.month] })],
);
