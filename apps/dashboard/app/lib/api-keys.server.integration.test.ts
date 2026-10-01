// Key lifecycle against the real schema: creation stores only the hash and
// the display prefix, the list never exposes the hash, revocation sets
// `revoked_at` once, and a revoked key no longer resolves through the same
// lookup shape the api worker uses (hash → row WHERE revoked_at IS NULL).
import { API_KEY_PATTERN, hashApiKey } from "@proofql/core";
import { schema } from "@proofql/db";
import { project, setupTestDb } from "@proofql/db/test";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createApiKey, listApiKeys, revokeApiKey } from "./api-keys.server";

const t = setupTestDb();

/** The api's auth query (workers/api/src/auth.ts `lookupApiKey`), reduced. */
async function authenticates(plaintext: string): Promise<boolean> {
  const keyHash = await hashApiKey(plaintext);
  const rows = await t.db
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.keyHash, keyHash),
        isNull(schema.apiKeys.revokedAt),
      ),
    );
  return rows.length === 1;
}

describe("createApiKey", () => {
  it("stores the hash and prefix, never the plaintext", async () => {
    const p = await project(t.db);
    const { key, plaintext } = await createApiKey(t.db, {
      projectId: p.id,
      kind: "publishable",
      environment: "test",
    });

    expect(plaintext).toMatch(API_KEY_PATTERN);
    expect(plaintext.startsWith("pq_pk_test_")).toBe(true);
    expect(key.prefix).toBe(plaintext.slice(0, "pq_pk_test_".length + 4));
    expect(key.kind).toBe("publishable");
    expect(key.environment).toBe("test");
    expect(key.revokedAt).toBeNull();
    expect(key.lastUsedAt).toBeNull();

    const [row] = await t.sql<
      { key_hash: string; prefix: string }[]
    >`SELECT key_hash, prefix FROM api_keys WHERE id = ${key.id}`;
    expect(row?.key_hash).toBe(await hashApiKey(plaintext));
    expect(row?.key_hash).not.toContain(plaintext);
    expect(row?.prefix).toBe(key.prefix);
    expect(JSON.stringify(row)).not.toContain(plaintext.slice(-20));

    expect(await authenticates(plaintext)).toBe(true);
  });

  it("lists a project's keys without the hash, active first", async () => {
    const p = await project(t.db);
    const a = await createApiKey(t.db, {
      projectId: p.id,
      kind: "secret",
      environment: "live",
    });
    const b = await createApiKey(t.db, {
      projectId: p.id,
      kind: "publishable",
      environment: "live",
    });
    await revokeApiKey(t.db, { projectId: p.id, keyId: b.key.id });

    const list = await listApiKeys(t.db, p.id);
    expect(list.map((k) => k.id)).toEqual([a.key.id, b.key.id]);
    expect(list[1]?.revokedAt).toBeInstanceOf(Date);
    for (const item of list) {
      expect(Object.keys(item)).not.toContain("keyHash");
    }
    // Another project's list is empty.
    expect(await listApiKeys(t.db, (await project(t.db)).id)).toEqual([]);
  });
});

describe("revokeApiKey", () => {
  it("sets revoked_at once and the key stops authenticating", async () => {
    const p = await project(t.db);
    const { key, plaintext } = await createApiKey(t.db, {
      projectId: p.id,
      kind: "secret",
      environment: "live",
    });
    expect(await authenticates(plaintext)).toBe(true);

    const revoked = await revokeApiKey(t.db, {
      projectId: p.id,
      keyId: key.id,
    });
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    expect(await authenticates(plaintext)).toBe(false);

    // Idempotent: a second revoke matches nothing and leaves the timestamp.
    expect(
      await revokeApiKey(t.db, { projectId: p.id, keyId: key.id }),
    ).toBeUndefined();
    const [row] = await t.sql<
      { revoked_at: string | Date }[]
    >`SELECT revoked_at FROM api_keys WHERE id = ${key.id}`;
    expect(new Date(row?.revoked_at ?? 0).getTime()).toBe(
      revoked?.revokedAt?.getTime(),
    );
  });

  it("is scoped to the project — another project's id matches nothing", async () => {
    const p = await project(t.db);
    const other = await project(t.db);
    const { key, plaintext } = await createApiKey(t.db, {
      projectId: p.id,
      kind: "secret",
      environment: "live",
    });
    expect(
      await revokeApiKey(t.db, { projectId: other.id, keyId: key.id }),
    ).toBeUndefined();
    expect(await authenticates(plaintext)).toBe(true);
  });
});
