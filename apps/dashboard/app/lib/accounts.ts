/**
 * Account and project reads/writes for the dashboard. Plain functions over
 * a `Db` so they run identically in loaders (Hyperdrive) and the
 * integration tests (@proofql/db harness).
 */
import { type Db, schema } from "@proofql/db";
import { and, asc, eq, isNull } from "drizzle-orm";

export type Account = typeof schema.accounts.$inferSelect;
export type Project = typeof schema.projects.$inferSelect;

export async function findAccountByClerkOrgId(
  db: Db,
  clerkOrgId: string,
): Promise<Account | undefined> {
  return db.query.accounts.findFirst({
    where: eq(schema.accounts.clerkOrgId, clerkOrgId),
  });
}

/**
 * Create or refresh the account that mirrors a Clerk Organization.
 * Idempotent on `clerk_org_id`: a second call with the same org updates the
 * name (and clears a soft-delete mark) instead of inserting a duplicate.
 * Plan and Stripe state are never touched here — billing owns those.
 */
export async function upsertAccountByClerkOrgId(
  db: Db,
  input: { clerkOrgId: string; name: string },
): Promise<Account> {
  const [row] = await db
    .insert(schema.accounts)
    .values({ clerkOrgId: input.clerkOrgId, name: input.name })
    .onConflictDoUpdate({
      target: schema.accounts.clerkOrgId,
      set: { name: input.name, deletedAt: null, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("accounts upsert returned no row");
  return row;
}

/** Soft-delete: see the column comment in packages/db/src/schema/tenancy.ts. */
export async function markAccountDeleted(
  db: Db,
  clerkOrgId: string,
): Promise<Account | undefined> {
  const [row] = await db
    .update(schema.accounts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.accounts.clerkOrgId, clerkOrgId),
        isNull(schema.accounts.deletedAt),
      ),
    )
    .returning();
  return row;
}

export async function listProjectsForAccount(
  db: Db,
  accountId: string,
): Promise<Project[]> {
  return db.query.projects.findMany({
    where: eq(schema.projects.accountId, accountId),
    orderBy: [asc(schema.projects.createdAt)],
  });
}

export async function findProjectBySlug(
  db: Db,
  accountId: string,
  slug: string,
): Promise<Project | undefined> {
  return db.query.projects.findFirst({
    where: and(
      eq(schema.projects.accountId, accountId),
      eq(schema.projects.slug, slug),
    ),
  });
}
