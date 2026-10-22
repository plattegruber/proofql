/**
 * Tenancy — `accounts` and `projects`, the root of the data model
 * (scope.md §4).
 *
 * An account mirrors a Clerk Organization (Clerk owns sign-in and
 * membership; we keep only the join key and billing state). A project is one
 * website or business: it owns API keys, the publication policy the query
 * API applies in SQL (`min_rating`, `similarity_floor`), the CORS allowlist
 * for publishable keys, and the badge flag. Everything else in the schema
 * hangs off `project_id`.
 *
 * Policy columns live on the project rather than in KV so that a policy
 * change and the rows it governs are in one transactional store; the KV
 * cache is purged on change, never consulted for policy.
 */

import { DEFAULT_SIMILARITY_FLOOR, PLAN_NAMES, type Plan } from "@proofql/core";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { id, timestamps } from "./shared.js";

/** Values from core (#61); `ACCOUNT_PLANS` / `AccountPlan` are the db-side names. */
export const ACCOUNT_PLANS = PLAN_NAMES;
export type AccountPlan = Plan;
export const accountPlanEnum = pgEnum("account_plan", ACCOUNT_PLANS);

export const accounts = pgTable("accounts", {
  id: id(),
  /** Clerk Organization id — the join point for webhooks and JWT resolution. */
  clerkOrgId: text("clerk_org_id").notNull().unique(),
  name: text("name").notNull(),
  plan: accountPlanEnum("plan").notNull().default("free"),
  /** Set once Stripe billing lands (M3); null on the free tier. */
  stripeCustomerId: text("stripe_customer_id").unique(),
  /**
   * Set by the dashboard's Clerk webhook on `organization.deleted` (#36).
   * A soft mark, not a DELETE: deleting the row would cascade through
   * every project, key, review and chunk the moment someone removes the
   * organization in Clerk, and that is not reversible. The data stays for
   * `ACCOUNT_PURGE_AFTER_DAYS` (30), then the pipeline's daily purge
   * hard-deletes the row and everything that cascades from it (#169,
   * `purgeDeletedAccounts` in ../tenancy/purge.ts). Until then a sign-in
   * with the same Clerk organization clears the mark (`requireAccount`
   * upserts by `clerk_org_id`); after it, that sign-in creates a new,
   * empty account — nothing is left to revive.
   */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  /**
   * When the guided onboarding (#53) was finished or dismissed for this
   * account. Null means a sign-in with zero projects lands on
   * `/app/onboarding`; set, the overview shows as usual. On the account
   * rather than in a cookie so the decision follows the user across
   * devices and browsers.
   */
  onboardingCompletedAt: timestamp("onboarding_completed_at", {
    withTimezone: true,
  }),
  ...timestamps,
});

export const projects = pgTable(
  "projects",
  {
    id: id(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * URL-safe handle used in dashboard routes. Unique per account, not
     * globally (migration 0002, #63): two accounts can both call a project
     * `website`; one account cannot have two.
     */
    slug: text("slug").notNull(),
    /**
     * Origins a publishable key may be used from (CORS). Empty means the
     * project has not configured any yet and publishable keys are refused
     * from browsers.
     */
    allowedOrigins: text("allowed_origins")
      .array()
      .notNull()
      .default([] as string[]),
    /** Publication policy: reviews rated below this never render (§3). */
    minRating: smallint("min_rating").notNull().default(4),
    /**
     * Relevance floor on cosine similarity. Candidates below it are dropped
     * so the API returns `[]` rather than padding — "empty beats irrelevant".
     */
    similarityFloor: doublePrecision("similarity_floor")
      .notNull()
      .default(DEFAULT_SIMILARITY_FLOOR),
    /**
     * The kind of business (#151): a key of `CATEGORY_TABLE` in
     * `@proofql/core` (`dental`, `roofing`, …), or null when unknown. It
     * picks the generic query words the floor's partial word match ignores
     * (`genericQueryWords`). Set from Google's primary type on a Places or
     * Business Profile import while still null; owners change it in
     * Settings. Plain text, validated in code, so the table grows without
     * a migration; a value this build does not know acts like null.
     */
    category: text("category"),
    /** Derived from the account plan; stored so the query API reads one row. */
    showBadge: boolean("show_badge").notNull().default(true),
    /** Denormalized count of live reviews, for limits and the dashboard. */
    reviewCount: integer("review_count").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index("projects_account_id_idx").on(table.accountId),
    unique("projects_account_id_slug_unique").on(table.accountId, table.slug),
  ],
);
