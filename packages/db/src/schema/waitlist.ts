/**
 * `waitlist` — email addresses left on `/sign-up` while public signup is
 * closed (`SIGNUP_OPEN`, docs/launch.md "Go").
 *
 * Deliberately not tied to an account: nobody on this list has one yet.
 * `email` is unique and stored lowercased by the dashboard, so a second
 * submission is a no-op rather than a duplicate row; `source` records which
 * surface collected it (`sign-up` today; a landing-page form later) so the
 * launch mail can be segmented. No `updated_at`: rows are written once.
 */

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const WAITLIST_SOURCE_DEFAULT = "sign-up";

export const waitlist = pgTable("waitlist", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  source: text("source").notNull().default(WAITLIST_SOURCE_DEFAULT),
});
