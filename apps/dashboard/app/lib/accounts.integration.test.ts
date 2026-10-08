// Account sync against the real schema: the upsert by clerk_org_id is
// idempotent, the soft-delete mark round-trips, and the webhook dispatcher
// drives both through the same functions the loaders use.
import { account, project, setupTestDb } from "@proofql/db/test";
import { describe, expect, it } from "vitest";

import {
  findAccountByClerkOrgId,
  findProjectBySlug,
  listProjectsForAccount,
  markAccountDeleted,
  upsertAccountByClerkOrgId,
} from "./accounts";
import { applyClerkEvent } from "./clerk-webhook.server";

const t = setupTestDb();

describe("upsertAccountByClerkOrgId", () => {
  it("inserts once and updates in place on repeat — one row, same id", async () => {
    const first = await upsertAccountByClerkOrgId(t.db, {
      clerkOrgId: "org_idem",
      name: "Acme",
    });
    const second = await upsertAccountByClerkOrgId(t.db, {
      clerkOrgId: "org_idem",
      name: "Acme",
    });
    const renamed = await upsertAccountByClerkOrgId(t.db, {
      clerkOrgId: "org_idem",
      name: "Acme Holdings",
    });

    expect(second.id).toBe(first.id);
    expect(renamed.id).toBe(first.id);
    expect(renamed.name).toBe("Acme Holdings");
    expect(renamed.plan).toBe("free");

    const rows = await t.sql`
      SELECT count(*)::int AS n FROM accounts WHERE clerk_org_id = 'org_idem'
    `;
    expect(rows[0]?.n).toBe(1);
  });

  it("never touches plan or billing state", async () => {
    const paid = await account(t.db, {
      clerkOrgId: "org_paid",
      plan: "paid",
      stripeCustomerId: "cus_123",
    });
    const after = await upsertAccountByClerkOrgId(t.db, {
      clerkOrgId: "org_paid",
      name: "Still paid",
    });
    expect(after.id).toBe(paid.id);
    expect(after.plan).toBe("paid");
    expect(after.stripeCustomerId).toBe("cus_123");
  });
});

describe("upsertAccountByClerkOrgId — the creator", () => {
  it("records the creator once and never moves it", async () => {
    const created = await upsertAccountByClerkOrgId(t.db, {
      clerkOrgId: "org_creator",
      name: "Acme",
      createdByUserId: "user_a",
    });
    expect(created.createdByUserId).toBe("user_a");
    const renamed = await upsertAccountByClerkOrgId(t.db, {
      clerkOrgId: "org_creator",
      name: "Acme 2",
      createdByUserId: "user_b",
    });
    expect(renamed.createdByUserId).toBe("user_a");
    const noCreator = await upsertAccountByClerkOrgId(t.db, {
      clerkOrgId: "org_creator",
      name: "Acme 3",
    });
    expect(noCreator.createdByUserId).toBe("user_a");
  });

  it("fills a missing creator on a later upsert", async () => {
    await upsertAccountByClerkOrgId(t.db, {
      clerkOrgId: "org_late",
      name: "Late",
    });
    const filled = await upsertAccountByClerkOrgId(t.db, {
      clerkOrgId: "org_late",
      name: "Late",
      createdByUserId: "user_late",
    });
    expect(filled.createdByUserId).toBe("user_late");
  });
});

describe("markAccountDeleted", () => {
  it("sets deleted_at once, and an upsert clears it again", async () => {
    await account(t.db, { clerkOrgId: "org_gone" });
    const marked = await markAccountDeleted(t.db, "org_gone");
    expect(marked?.deletedAt).toBeInstanceOf(Date);
    // Second mark is a no-op (already deleted) — nothing matched.
    expect(await markAccountDeleted(t.db, "org_gone")).toBeUndefined();
    expect(await markAccountDeleted(t.db, "org_never")).toBeUndefined();

    const revived = await upsertAccountByClerkOrgId(t.db, {
      clerkOrgId: "org_gone",
      name: "Back",
    });
    expect(revived.deletedAt).toBeNull();
  });
});

describe("applyClerkEvent", () => {
  it("drives created → updated → deleted through the same row", async () => {
    const created = await applyClerkEvent(t.db, {
      type: "organization.created",
      object: "event",
      data: { id: "org_evt", name: "Event Co", slug: "event-co" },
    } as never);
    expect(created).toEqual({ type: "organization.created", handled: true });

    await applyClerkEvent(t.db, {
      type: "organization.updated",
      object: "event",
      data: { id: "org_evt", name: "Event Co, Ltd", slug: "event-co" },
    } as never);
    const row = await findAccountByClerkOrgId(t.db, "org_evt");
    expect(row?.name).toBe("Event Co, Ltd");

    const deleted = await applyClerkEvent(t.db, {
      type: "organization.deleted",
      object: "event",
      data: { id: "org_evt", object: "organization", deleted: true },
    } as never);
    expect(deleted).toEqual({ type: "organization.deleted", handled: true });
    expect(
      (await findAccountByClerkOrgId(t.db, "org_evt"))?.deletedAt,
    ).toBeInstanceOf(Date);
  });
});

describe("projects for an account", () => {
  it("lists only the account's projects and finds by slug within it", async () => {
    const a = await account(t.db);
    const b = await account(t.db);
    const p1 = await project(t.db, { accountId: a.id, slug: "website" });
    await project(t.db, { accountId: a.id, slug: "shop" });
    await project(t.db, { accountId: b.id, slug: "website" });

    const list = await listProjectsForAccount(t.db, a.id);
    expect(list.map((p) => p.slug)).toEqual(["website", "shop"]);
    expect((await findProjectBySlug(t.db, a.id, "website"))?.id).toBe(p1.id);
    expect(await findProjectBySlug(t.db, b.id, "shop")).toBeUndefined();
  });
});
