// The webhook endpoint's verification and dispatch, with Postgres replaced
// by a recording fake (the real upsert is covered in
// accounts.integration.test.ts) and signatures produced by the test signer.
import type { Db } from "@proofql/db";
import { describe, expect, it, vi } from "vitest";

import {
  clerkEvent,
  signClerkWebhook,
  TEST_SIGNING_SECRET,
} from "../../test/clerk-webhook";
import {
  handleClerkWebhook,
  MAX_WEBHOOK_BODY_BYTES,
} from "./clerk-webhook.server";

vi.mock("./accounts", () => ({
  upsertAccountByClerkOrgId: vi.fn(async (_db, input) => ({ ...input })),
  markAccountDeleted: vi.fn(async (_db, clerkOrgId) =>
    clerkOrgId === "org_known" ? { clerkOrgId } : undefined,
  ),
}));

const accounts = await import("./accounts");
const db = {} as Db;

async function post(body: string, headers: Record<string, string>) {
  return handleClerkWebhook(
    new Request("https://dash.test/webhooks/clerk", {
      method: "POST",
      body,
      headers,
    }),
    { signingSecret: TEST_SIGNING_SECRET, db },
  );
}

describe("handleClerkWebhook — verification", () => {
  it("accepts a correctly signed delivery", async () => {
    const body = clerkEvent("organization.created", {
      id: "org_1",
      name: "Acme",
      slug: "acme",
    });
    const res = await post(body, await signClerkWebhook(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      type: "organization.created",
      handled: true,
    });
  });

  it("rejects a delivery signed with another secret", async () => {
    const body = clerkEvent("organization.created", { id: "org_1", name: "x" });
    const headers = await signClerkWebhook(body, {
      secret: `whsec_${btoa("ffffffffffffffffffffffffffffffff")}`,
    });
    const res = await post(body, headers);
    expect(res.status).toBe(400);
    expect(accounts.upsertAccountByClerkOrgId).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ name: "x" }),
    );
  });

  it("rejects a body that changed after signing", async () => {
    const body = clerkEvent("organization.created", { id: "org_1", name: "a" });
    const headers = await signClerkWebhook(body);
    const res = await post(body.replace('"a"', '"b"'), headers);
    expect(res.status).toBe(400);
  });

  it("rejects a stale timestamp (replay)", async () => {
    const body = clerkEvent("organization.created", { id: "org_1", name: "a" });
    const headers = await signClerkWebhook(body, {
      timestamp: Math.floor(Date.now() / 1000) - 60 * 60,
    });
    expect((await post(body, headers)).status).toBe(400);
  });

  it("rejects missing svix headers", async () => {
    const body = clerkEvent("organization.created", { id: "org_1", name: "a" });
    const res = await post(body, { "content-type": "application/json" });
    expect(res.status).toBe(400);
  });

  it("rejects a body over 256 KiB before verifying it, even when correctly signed", async () => {
    const padding = "x".repeat(MAX_WEBHOOK_BODY_BYTES);
    const body = clerkEvent("organization.created", {
      id: "org_big",
      name: "a",
      padding,
    });
    expect(body.length).toBeGreaterThan(MAX_WEBHOOK_BODY_BYTES);
    // Signed with the right secret: the size check, not the HMAC, refuses it.
    const res = await post(body, await signClerkWebhook(body));
    expect(res.status).toBe(413);
    expect(accounts.upsertAccountByClerkOrgId).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ clerkOrgId: "org_big" }),
    );
    // A lying Content-Length is refused from the header alone.
    const small = clerkEvent("organization.created", {
      id: "org_s",
      name: "a",
    });
    const lying = await post(small, {
      ...(await signClerkWebhook(small)),
      "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1),
    });
    expect(lying.status).toBe(413);
  });

  it("rejects a timestamp just past the 5-minute tolerance and accepts one inside it", async () => {
    const body = clerkEvent("organization.created", { id: "org_1", name: "a" });
    const now = Math.floor(Date.now() / 1000);
    const stale = await post(
      body,
      await signClerkWebhook(body, { timestamp: now - 5 * 60 - 30 }),
    );
    expect(stale.status).toBe(400);
    const fresh = await post(
      body,
      await signClerkWebhook(body, { timestamp: now - 4 * 60 }),
    );
    expect(fresh.status).toBe(200);
  });

  it("answers 503, not 400, when the signing secret is not configured", async () => {
    const body = clerkEvent("organization.created", { id: "org_1", name: "a" });
    const res = await handleClerkWebhook(
      new Request("https://dash.test/webhooks/clerk", {
        method: "POST",
        body,
        headers: await signClerkWebhook(body),
      }),
      { signingSecret: undefined, db },
    );
    expect(res.status).toBe(503);
  });
});

describe("handleClerkWebhook — dispatch", () => {
  it("upserts on organization.updated", async () => {
    const body = clerkEvent("organization.updated", {
      id: "org_2",
      name: "Acme, renamed",
      slug: "acme",
    });
    const res = await post(body, await signClerkWebhook(body));
    expect(res.status).toBe(200);
    expect(accounts.upsertAccountByClerkOrgId).toHaveBeenCalledWith(db, {
      clerkOrgId: "org_2",
      name: "Acme, renamed",
      createdByUserId: null,
    });
  });

  it("records the organization's creator for the per-person free allowance", async () => {
    const body = clerkEvent("organization.created", {
      id: "org_3",
      name: "Acme",
      slug: "acme",
      created_by: "user_creator",
    });
    const res = await post(body, await signClerkWebhook(body));
    expect(res.status).toBe(200);
    expect(accounts.upsertAccountByClerkOrgId).toHaveBeenCalledWith(db, {
      clerkOrgId: "org_3",
      name: "Acme",
      createdByUserId: "user_creator",
    });
  });

  it("soft-marks on organization.deleted and reports whether a row matched", async () => {
    const known = clerkEvent("organization.deleted", {
      id: "org_known",
      deleted: true,
    });
    expect(
      await (await post(known, await signClerkWebhook(known))).json(),
    ).toEqual({ ok: true, type: "organization.deleted", handled: true });
    const unknown = clerkEvent("organization.deleted", {
      id: "org_unknown",
      deleted: true,
    });
    expect(
      await (await post(unknown, await signClerkWebhook(unknown))).json(),
    ).toEqual({ ok: true, type: "organization.deleted", handled: false });
  });

  it("acknowledges unrelated events with 200 so Clerk stops retrying", async () => {
    const body = clerkEvent("user.created", { id: "user_1" });
    const res = await post(body, await signClerkWebhook(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      type: "user.created",
      handled: false,
    });
  });
});
