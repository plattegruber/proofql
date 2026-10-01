/**
 * API key management for the Keys tab (#37). Mint through `@proofql/core`'s
 * `generateApiKey`, store only the SHA-256 hash and the display prefix, hand
 * the plaintext back exactly once to the action that asked for it. Nothing
 * here ever selects `key_hash`: the list shape below is what the browser is
 * allowed to see.
 */
import {
  type ApiKeyEnvironment,
  type ApiKeyKind,
  generateApiKey,
} from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { and, desc, eq, isNull } from "drizzle-orm";

export interface ApiKeyListItem {
  id: string;
  kind: ApiKeyKind;
  environment: ApiKeyEnvironment;
  /** Non-secret display head, e.g. `pq_sk_live_Ab3x`. */
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** A project's keys, newest first, active before revoked. */
export async function listApiKeys(
  db: Db,
  projectId: string,
): Promise<ApiKeyListItem[]> {
  const { apiKeys } = schema;
  const rows = await db
    .select({
      id: apiKeys.id,
      kind: apiKeys.kind,
      environment: apiKeys.environment,
      prefix: apiKeys.prefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.projectId, projectId))
    .orderBy(desc(apiKeys.createdAt));
  return rows.sort((a, b) => {
    const aRevoked = a.revokedAt !== null ? 1 : 0;
    const bRevoked = b.revokedAt !== null ? 1 : 0;
    return aRevoked - bRevoked;
  });
}

export interface CreatedApiKey {
  key: ApiKeyListItem;
  /** Show once; never store, log, or return from a loader. */
  plaintext: string;
}

export async function createApiKey(
  db: Db,
  input: {
    projectId: string;
    kind: ApiKeyKind;
    environment: ApiKeyEnvironment;
  },
): Promise<CreatedApiKey> {
  const minted = await generateApiKey({
    kind: input.kind,
    environment: input.environment,
  });
  const [row] = await db
    .insert(schema.apiKeys)
    .values({
      projectId: input.projectId,
      kind: minted.kind,
      environment: minted.environment,
      keyHash: minted.hash,
      prefix: minted.prefix,
    })
    .returning({
      id: schema.apiKeys.id,
      kind: schema.apiKeys.kind,
      environment: schema.apiKeys.environment,
      prefix: schema.apiKeys.prefix,
      createdAt: schema.apiKeys.createdAt,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      revokedAt: schema.apiKeys.revokedAt,
    });
  if (!row) throw new Error("api_keys insert returned no row");
  return { key: row, plaintext: minted.plaintext };
}

/**
 * Revoke a key: set `revoked_at` once. Scoped to the project so an id from
 * another project matches nothing. Returns the row, or undefined when the
 * key was unknown or already revoked.
 */
export async function revokeApiKey(
  db: Db,
  ids: { projectId: string; keyId: string },
): Promise<ApiKeyListItem | undefined> {
  const { apiKeys } = schema;
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, ids.keyId),
        eq(apiKeys.projectId, ids.projectId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({
      id: apiKeys.id,
      kind: apiKeys.kind,
      environment: apiKeys.environment,
      prefix: apiKeys.prefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    });
  return row;
}
