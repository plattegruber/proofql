/**
 * Meta-tests for the harness itself: per-file database isolation, template
 * fidelity (the clone carries pgvector and the generated column), and
 * factories that satisfy every NOT NULL / unique / FK constraint.
 */

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { reviews } from "../src/schema/reviews.js";
import { accounts } from "../src/schema/tenancy.js";
import { account, apiKey, chunk, project, review } from "./factories.js";
import { setupTestDb } from "./harness.js";
import { TEMPLATE_DB } from "./support.js";

const ISOLATION_MARKER = "org_isolation_marker";
const seenDatabaseNames: string[] = [];

describe("scope A: writes a marker row into its own database", () => {
  const t = setupTestDb();

  it("runs in a private test_ database", () => {
    seenDatabaseNames.push(t.databaseName);
    expect(t.databaseName).toMatch(/^test_\d{10,}_\d+_\d+$/);
  });

  it("clones from a template stamped with the migrations fingerprint", async () => {
    const [row] = await t.sql`
      SELECT shobj_description(oid, 'pg_database') AS fingerprint
      FROM pg_database WHERE datname = ${TEMPLATE_DB}
    `;
    expect(row?.fingerprint).toMatch(/^migrations sha256:[0-9a-f]{64}$/);
  });

  it("inserts the marker row other scopes must never see", async () => {
    await account(t.db, { clerkOrgId: ISOLATION_MARKER });
    const rows = await t.db
      .select()
      .from(accounts)
      .where(eq(accounts.clerkOrgId, ISOLATION_MARKER));
    expect(rows).toHaveLength(1);
  });
});

describe("scope B: gets a different, empty database", () => {
  const t = setupTestDb();

  it("has a different database name than scope A", () => {
    seenDatabaseNames.push(t.databaseName);
    expect(seenDatabaseNames).toHaveLength(2);
    expect(seenDatabaseNames[0]).not.toBe(seenDatabaseNames[1]);
  });

  it("cannot see scope A's rows", async () => {
    const all = await t.db.select().from(accounts);
    expect(all).toHaveLength(0);
  });
});

describe("template fidelity: the clone is the real schema", () => {
  const t = setupTestDb();

  it("has the vector extension", async () => {
    const ext = await t.sql`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `;
    expect(ext).toHaveLength(1);
  });

  it("has every table from scope.md §4 and nothing else", async () => {
    const rows = await t.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    expect(rows.map((r) => r.table_name)).toEqual([
      "accounts",
      "api_keys",
      "connections",
      "ingest_runs",
      "projects",
      "review_chunks",
      "reviews",
      "usage",
    ]);
  });

  it("has no approximate-nearest-neighbor index (no HNSW, no IVFFlat)", async () => {
    const rows = await t.sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
    `;
    for (const { indexdef } of rows) {
      expect(indexdef).not.toMatch(/USING (hnsw|ivfflat)/i);
    }
  });
});

describe("factories: one of everything, constraints satisfied", () => {
  const t = setupTestDb();

  it("builds the tenancy chain with defaults and honors overrides", async () => {
    const p = await project(t.db, { name: "Override Co" });
    expect(p.name).toBe("Override Co");
    expect(p.minRating).toBe(4);
    expect(p.similarityFloor).toBe(0.55);
    expect(p.showBadge).toBe(true);
    expect(p.reviewCount).toBe(0);
    expect(p.allowedOrigins).toEqual([]);

    const [a] = await t.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, p.accountId));
    expect(a?.plan).toBe("free");
  });

  it("apiKey() derives a kind/environment-shaped prefix", async () => {
    const k = await apiKey(t.db, { kind: "publishable", environment: "test" });
    expect(k.prefix).toMatch(/^pq_pk_test_[0-9a-f]{4}$/);
    expect(k.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.revokedAt).toBeNull();
  });

  it("chunk() alone builds the full graph and copies tenant columns", async () => {
    const c = await chunk(t.db);
    expect(c.kind).toBe("full");
    expect(c.startOffset).toBe(0);
    expect(c.embedding).toBeNull();
    const [parent] = await t.db
      .select()
      .from(reviews)
      .where(eq(reviews.id, c.reviewId));
    expect(parent?.projectId).toBe(c.projectId);
    expect(parent?.environment).toBe(c.environment);
    expect(c.text).toBe(parent?.text);
  });

  it("repeated no-arg factories never collide on unique constraints", async () => {
    const r1 = await review(t.db);
    const r2 = await review(t.db, { projectId: r1.projectId });
    expect(r1.externalId).not.toBe(r2.externalId);
    const k1 = await apiKey(t.db, { projectId: r1.projectId });
    const k2 = await apiKey(t.db, { projectId: r1.projectId });
    expect(k1.keyHash).not.toBe(k2.keyHash);
  });
});
