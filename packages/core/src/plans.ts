/**
 * The plan table (scope.md §2 "Free tier"; issue #54) — the single source of
 * truth for every number a plan changes. v0 numbers; tune with data.
 *
 * Everything that enforces or displays a limit reads `PLANS` through
 * `planFor`: the review cap at the write path (@proofql/db `upsertReviews`),
 * the monthly query quota (workers/api `quota.ts`), the per-key rate
 * limits and the headers that advertise them (workers/api `rate-limit.ts`),
 * the project allowance (apps/dashboard `projects.server.ts`), the badge
 * flag in the query response (workers/api `query/route.ts`) and the usage
 * panel on the dashboard overview. The future docs site's Limits page reads
 * `planTableMarkdown()` / `planTableJson()` so it cannot drift either.
 *
 * `projects.show_badge` is a cached mirror of `planFor(accounts.plan).badge`
 * (@proofql/db `syncProjectBadges`), never the truth: the API derives the
 * badge from the plan on every request.
 *
 * Plan changes happen only by SQL / the ops script today (billing is M3);
 * the paid numbers are placeholders for "many" / "metered" and ceilings
 * against runaway scripts, not product promises.
 */

export const PLAN_NAMES = ["free", "paid"] as const;
export type Plan = (typeof PLAN_NAMES)[number];

export interface PlanRateLimits {
  /** Requests per minute per secret key (servers). */
  secret: number;
  /** Requests per minute per publishable key (browsers, the snippet). */
  publishable: number;
}

export interface PlanLimits {
  /** Projects per account. */
  projects: number;
  /** Live + test reviews per project, enforced before anything is written. */
  reviewsPerProject: number;
  /** Uncached `/v1/query` calls per project per UTC month; cached hits are free. */
  queriesPerMonth: number;
  /** Whether the snippet must render the "Reviews by ProofQL" badge. */
  badge: boolean;
  rateLimits: PlanRateLimits;
}

export const PLANS: Readonly<Record<Plan, Readonly<PlanLimits>>> = {
  free: {
    projects: 1,
    reviewsPerProject: 5_000,
    queriesPerMonth: 50_000,
    badge: true,
    rateLimits: { secret: 300, publishable: 120 },
  },
  paid: {
    projects: 50,
    reviewsPerProject: 100_000,
    queriesPerMonth: 2_000_000,
    badge: false,
    rateLimits: { secret: 1_000, publishable: 600 },
  },
};

/** Window the `rateLimits` numbers are counted over, in seconds. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/**
 * Where "upgrade" points until billing (M3) gives every surface a real
 * checkout. One constant so every message, link and error names the same
 * place and the swap is one line.
 */
export const PRICING_URL = "https://proofql.dev/pricing";

/** Display names, for the dashboard and error messages. */
export const PLAN_LABELS: Readonly<Record<Plan, string>> = {
  free: "Free",
  paid: "Paid",
};

/**
 * `hasOwn`, not a bare index: `plan` comes from a database enum today, but
 * a string like "toString" must still resolve to the free plan rather than
 * an inherited property.
 */
export function isPlan(plan: string): plan is Plan {
  return Object.hasOwn(PLANS, plan);
}

/** Normalize any string to a known plan; unknown plans are treated as free. */
export function normalizePlan(plan: string): Plan {
  return isPlan(plan) ? plan : "free";
}

/** The limits for a plan; unknown plans get the free tier's. */
export function planFor(plan: string): Readonly<PlanLimits> {
  return PLANS[normalizePlan(plan)];
}

/** Display name for a plan; unknown plans are shown as they are spelled. */
export function planLabel(plan: string): string {
  return isPlan(plan) ? PLAN_LABELS[plan] : plan;
}

/** Rows of the plan table as the docs site's Limits page should show them. */
export interface PlanTableRow {
  limit: string;
  free: string;
  paid: string;
}

const fmt = (n: number): string => n.toLocaleString("en-US");

/** `PLANS` as display rows — the one shape both renderers below share. */
export function planTableRows(): PlanTableRow[] {
  const { free, paid } = PLANS;
  const perMinute = (n: number) => `${fmt(n)} / min`;
  return [
    { limit: "Projects", free: fmt(free.projects), paid: fmt(paid.projects) },
    {
      limit: "Reviews per project",
      free: fmt(free.reviewsPerProject),
      paid: fmt(paid.reviewsPerProject),
    },
    {
      limit: "Queries per month (cached hits are free)",
      free: fmt(free.queriesPerMonth),
      paid: fmt(paid.queriesPerMonth),
    },
    {
      limit: "Rate limit, secret key",
      free: perMinute(free.rateLimits.secret),
      paid: perMinute(paid.rateLimits.secret),
    },
    {
      limit: "Rate limit, publishable key",
      free: perMinute(free.rateLimits.publishable),
      paid: perMinute(paid.rateLimits.publishable),
    },
    {
      limit: "Snippet badge",
      free: free.badge ? "Shown" : "Removable",
      paid: paid.badge ? "Shown" : "Removable",
    },
  ];
}

/** The plan table as a GitHub-flavoured Markdown table, for the docs site. */
export function planTableMarkdown(): string {
  const lines = ["| Limit | Free | Paid |", "|---|---|---|"];
  for (const row of planTableRows()) {
    lines.push(`| ${row.limit} | ${row.free} | ${row.paid} |`);
  }
  return lines.join("\n");
}

/** `PLANS` serialized for a static docs build; stable key order. */
export function planTableJson(): string {
  return JSON.stringify(PLANS, null, 2);
}
