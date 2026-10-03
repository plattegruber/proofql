/**
 * The Google connect flow's server side (#45; docs/google.md "Connecting").
 *
 * Plain functions over an injected `Db`, KV and env so the integration test
 * (`google.server.integration.test.ts`) drives the whole flow against the
 * real schema and the fake Google server, and the three route modules stay
 * thin:
 *
 *   GET /app/projects/:slug/integrations/google/connect   → beginConnect → 302 to Google
 *   GET /app/integrations/google/callback?code&state       → completeConnect → 302 to the tab
 *   /app/projects/:slug/integrations                       → the tab (loader + save / disconnect)
 *
 * Security shape: the `state` is HMAC-signed with `GOOGLE_OAUTH_STATE_SECRET`
 * and carries `{ projectId, accountId, nonce, exp }`; the nonce is stored
 * single-use in KV (`oauth:<nonce>`, ten-minute TTL) together with the PKCE
 * verifier, and deleted on first use — a replayed callback finds no nonce
 * and is refused. The callback also requires the signed-in account to be
 * the one that started the connect. Credentials are AES-GCM ciphertext
 * under `CREDENTIALS_KEY` from the moment they exist; a token never reaches
 * a log line.
 *
 * One Google connection per project (`connections_project_id_kind_unique`):
 * reconnecting replaces the credentials and re-runs discovery, keeping the
 * locations the user had enabled. Disconnecting clears the credentials and
 * sets `status = disconnected`; the reviews stay.
 */
import type { IngestMessage } from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import {
  applyLocationSelection,
  buildAuthorizeUrl,
  CONNECT_TTL_SECONDS,
  type ConnectionMetadata,
  codeChallengeS256,
  type DiscoveredLocations,
  discoverWithEndpoints,
  encryptCredentials,
  exchangeAuthorizationCode,
  expiryFrom,
  GoogleApiError,
  GoogleOAuthError,
  generateCodeVerifier,
  generateNonce,
  importCredentialsKey,
  type MappedLocation,
  mergeLocationMapping,
  parseConnectionMetadata,
  resolveGoogleEndpoints,
  StateError,
  signState,
  verifyState,
} from "@proofql/google";
import { and, desc, eq } from "drizzle-orm";

const { connections, ingestRuns } = schema;

export const CALLBACK_PATH = "/app/integrations/google/callback";

export function integrationsPath(slug: string): string {
  return `/app/projects/${slug}/integrations`;
}

export function connectPath(slug: string): string {
  return `${integrationsPath(slug)}/google/connect`;
}

/** The env slice the flow reads; the generated `Env` fits structurally. */
export interface GoogleEnv {
  ENVIRONMENT?: string;
  CREDENTIALS_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_STATE_SECRET?: string;
  GOOGLE_OAUTH_BASE?: string;
  GOOGLE_TOKEN_URL?: string;
  GOOGLE_API_BASE?: string;
  GOOGLE_CONNECTOR_ENABLED?: string;
}

/** The KV surface the nonce store needs; `env.CACHE` (a `KVNamespace`) fits. */
export interface OAuthKv {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * The connector is dark until Google approves API access (#44): the var is
 * flipped to `"true"` per environment once the quota is 300 QPM. Locally
 * `.dev.vars.example` sets it, since everything talks to the fake.
 */
export function connectorEnabled(
  env: Pick<GoogleEnv, "GOOGLE_CONNECTOR_ENABLED">,
): boolean {
  return env.GOOGLE_CONNECTOR_ENABLED?.trim() === "true";
}

/** Same rule as the flash cookie's secret: a fixed dev-only value locally, required elsewhere. */
export function stateSecret(
  env: Pick<GoogleEnv, "ENVIRONMENT" | "GOOGLE_OAUTH_STATE_SECRET">,
): string {
  const configured = env.GOOGLE_OAUTH_STATE_SECRET?.trim() || undefined;
  if (configured === undefined && env.ENVIRONMENT !== "local") {
    throw new Error("GOOGLE_OAUTH_STATE_SECRET is not set");
  }
  return configured ?? "dev-only-insecure-google-state-secret";
}

function oauthConfig(env: GoogleEnv, fetchImpl?: typeof fetch) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set (docs/secrets.md)",
    );
  }
  return {
    endpoints: resolveGoogleEndpoints(env),
    clientId,
    clientSecret,
    fetch: fetchImpl,
  };
}

function nonceKey(nonce: string): string {
  return `oauth:${nonce}`;
}

interface NonceRecord {
  verifier: string;
  projectId: string;
  accountId: string;
}

export class ConnectError extends Error {
  override readonly name = "ConnectError";
  constructor(
    readonly reason:
      | "state_malformed"
      | "state_bad_signature"
      | "state_expired"
      | "nonce_missing"
      | "nonce_mismatch"
      | "account_mismatch"
      | "no_refresh_token"
      | "exchange_failed"
      | "discovery_failed",
    readonly detail?: string,
  ) {
    super(`Google connect failed: ${reason}${detail ? ` (${detail})` : ""}`);
  }
}

/** Step 1: mint verifier + nonce, store them, sign the state, build the URL. */
export async function beginConnect(input: {
  env: GoogleEnv;
  kv: OAuthKv;
  projectId: string;
  accountId: string;
  redirectUri: string;
  now?: () => number;
}): Promise<string> {
  const config = oauthConfig(input.env);
  const verifier = generateCodeVerifier();
  const nonce = generateNonce();
  const nowSeconds = Math.floor((input.now ?? Date.now)() / 1000);
  const record: NonceRecord = {
    verifier,
    projectId: input.projectId,
    accountId: input.accountId,
  };
  await input.kv.put(nonceKey(nonce), JSON.stringify(record), {
    expirationTtl: CONNECT_TTL_SECONDS,
  });
  const state = await signState(stateSecret(input.env), {
    projectId: input.projectId,
    accountId: input.accountId,
    nonce,
    exp: nowSeconds + CONNECT_TTL_SECONDS,
  });
  return buildAuthorizeUrl(config.endpoints, {
    clientId: config.clientId,
    redirectUri: input.redirectUri,
    state,
    codeChallenge: await codeChallengeS256(verifier),
  });
}

export type Connection = typeof connections.$inferSelect;

export interface CompletedConnect {
  connection: Connection;
  projectId: string;
  discovered: DiscoveredLocations | null;
  /** Set when discovery failed after the credentials were stored. */
  discoveryError?: string;
}

/**
 * Step 2: verify, exchange, store, discover. Throws {@link ConnectError}
 * before anything is written; after the credentials are stored, a discovery
 * failure is reported on the result instead (the connection exists; the
 * user can reconnect to retry).
 */
export async function completeConnect(input: {
  env: GoogleEnv;
  kv: OAuthKv;
  db: Db;
  code: string;
  state: string;
  /** The signed-in account; must match the one that started the connect. */
  accountId: string;
  redirectUri: string;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<CompletedConnect> {
  const now = input.now ?? Date.now;
  let state: Awaited<ReturnType<typeof verifyState>>;
  try {
    state = await verifyState(
      stateSecret(input.env),
      input.state,
      Math.floor(now() / 1000),
    );
  } catch (error) {
    if (error instanceof StateError) {
      throw new ConnectError(`state_${error.reason}` as ConnectError["reason"]);
    }
    throw error;
  }
  if (state.accountId !== input.accountId)
    throw new ConnectError("account_mismatch");

  // Single use: read and delete before anything else can observe it.
  const key = nonceKey(state.nonce);
  const raw = await input.kv.get(key);
  if (raw === null) throw new ConnectError("nonce_missing");
  await input.kv.delete(key);
  let record: NonceRecord;
  try {
    record = JSON.parse(raw) as NonceRecord;
  } catch {
    throw new ConnectError("nonce_mismatch");
  }
  if (
    record.projectId !== state.projectId ||
    record.accountId !== state.accountId
  ) {
    throw new ConnectError("nonce_mismatch");
  }

  const config = oauthConfig(input.env, input.fetch);
  let issued: Awaited<ReturnType<typeof exchangeAuthorizationCode>>;
  try {
    issued = await exchangeAuthorizationCode(config, {
      code: input.code,
      codeVerifier: record.verifier,
      redirectUri: input.redirectUri,
    });
  } catch (error) {
    if (error instanceof GoogleOAuthError) {
      throw new ConnectError(
        "exchange_failed",
        error.code ?? String(error.status),
      );
    }
    throw error;
  }
  if (!issued.refreshToken) throw new ConnectError("no_refresh_token");

  const cryptoKey = await importCredentialsKey(input.env.CREDENTIALS_KEY);
  const credentials = await encryptCredentials(cryptoKey, {
    access_token: issued.accessToken,
    refresh_token: issued.refreshToken,
    expiry: expiryFrom(issued.expiresIn, now()),
  });

  const existing = await findGoogleConnection(input.db, state.projectId);
  const previous = parseConnectionMetadata(existing?.metadata);
  const stamp = new Date(now());
  const [stored] = await input.db
    .insert(connections)
    .values({
      projectId: state.projectId,
      kind: "google",
      status: "active",
      credentials,
      cursor: existing?.cursor ?? null,
      metadata: { ...previous },
    })
    .onConflictDoUpdate({
      target: [connections.projectId, connections.kind],
      set: { status: "active", credentials, updatedAt: stamp },
    })
    .returning();
  if (!stored) throw new Error("connections upsert returned no row");

  let discovered: DiscoveredLocations | null = null;
  try {
    discovered = await discoverWithEndpoints(
      config.endpoints,
      issued.accessToken,
      input.fetch,
    );
  } catch (error) {
    const detail =
      error instanceof GoogleApiError
        ? `${error.googleStatus ?? "error"} (${error.status})`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      connection: stored,
      projectId: state.projectId,
      discovered: null,
      discoveryError: detail,
    };
  }

  const metadata: ConnectionMetadata = {
    ...previous,
    locations: mergeLocationMapping(previous.locations, discovered.locations),
    accounts: discovered.accounts,
    discovered_at: stamp.toISOString(),
  };
  const [updated] = await input.db
    .update(connections)
    .set({ metadata, updatedAt: stamp })
    .where(eq(connections.id, stored.id))
    .returning();
  return {
    connection: updated ?? stored,
    projectId: state.projectId,
    discovered,
  };
}

export async function findGoogleConnection(
  db: Db,
  projectId: string,
): Promise<Connection | undefined> {
  return db.query.connections.findFirst({
    where: and(
      eq(connections.projectId, projectId),
      eq(connections.kind, "google"),
    ),
  });
}

/**
 * Save which verified locations to poll. Sets `initial_sync_pending` so the
 * next cron tick takes the connection first; the action also enqueues a
 * `connection.sync` so it usually happens within seconds. Returns the
 * message to send after the write, or undefined when there is no
 * connection to save to.
 */
export async function saveLocationSelection(
  db: Db,
  input: { projectId: string; enabledIds: readonly string[] },
): Promise<
  | {
      connection: Connection;
      message: IngestMessage;
      enabled: MappedLocation[];
    }
  | undefined
> {
  const existing = await findGoogleConnection(db, input.projectId);
  if (!existing || existing.status === "disconnected") return undefined;
  const metadata = parseConnectionMetadata(existing.metadata);
  const locations = applyLocationSelection(metadata, input.enabledIds);
  const enabled = locations.filter((l) => l.enabled);
  const [row] = await db
    .update(connections)
    .set({
      metadata: {
        ...metadata,
        locations,
        ...(enabled.length > 0 ? { initial_sync_pending: true } : {}),
      },
      updatedAt: new Date(),
    })
    .where(eq(connections.id, existing.id))
    .returning();
  if (!row) return undefined;
  return {
    connection: row,
    enabled,
    message: {
      type: "connection.sync",
      connectionId: row.id,
      projectId: row.projectId,
    },
  };
}

/** Clear the credentials and mark the row disconnected; the mapping and the reviews stay. */
export async function disconnectGoogle(
  db: Db,
  projectId: string,
): Promise<Connection | undefined> {
  const [row] = await db
    .update(connections)
    .set({ status: "disconnected", credentials: null, updatedAt: new Date() })
    .where(
      and(eq(connections.projectId, projectId), eq(connections.kind, "google")),
    )
    .returning();
  return row;
}

export type GoogleRun = typeof ingestRuns.$inferSelect;

/** The newest Google ingest run for the tab's "last sync" line. */
export async function latestGoogleRun(
  db: Db,
  projectId: string,
): Promise<GoogleRun | undefined> {
  return db.query.ingestRuns.findFirst({
    where: and(
      eq(ingestRuns.projectId, projectId),
      eq(ingestRuns.kind, "google"),
    ),
    orderBy: [desc(ingestRuns.startedAt)],
  });
}

/** What the tab renders; dates as ISO strings so loader data is stable across the wire. */
export interface ConnectionView {
  status: Connection["status"];
  lastSyncedAt: string | null;
  initialSyncPending: boolean;
  discoveredAt: string | null;
  accounts: Record<string, string>;
  locations: MappedLocation[];
  lastRun: {
    status: GoogleRun["status"];
    startedAt: string;
    finishedAt: string | null;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    error: string | null;
  } | null;
}

export function connectionView(
  row: Connection,
  run: GoogleRun | undefined,
): ConnectionView {
  const metadata = parseConnectionMetadata(row.metadata);
  return {
    status: row.status,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    initialSyncPending: metadata.initial_sync_pending === true,
    discoveredAt: metadata.discovered_at ?? null,
    accounts: metadata.accounts ?? {},
    locations: metadata.locations,
    lastRun: run
      ? {
          status: run.status,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
          created: run.created,
          updated: run.updated,
          skipped: run.skipped,
          failed: run.failed,
          error: run.error,
        }
      : null,
  };
}

/** The user-facing sentence for a failed connect. */
export function connectErrorMessage(error: ConnectError): string {
  switch (error.reason) {
    case "state_expired":
      return "The Google sign-in took longer than ten minutes. Start again.";
    case "nonce_missing":
      return "This Google sign-in was already used or has expired. Start again.";
    case "no_refresh_token":
      return "Google did not grant offline access, so nothing was saved. Try again and accept every permission on the consent screen.";
    case "exchange_failed":
      return `Google refused the sign-in (${error.detail ?? "unknown error"}). Try again.`;
    case "account_mismatch":
      return "This Google sign-in was started from a different workspace.";
    default:
      return "The Google sign-in could not be verified. Start again.";
  }
}
