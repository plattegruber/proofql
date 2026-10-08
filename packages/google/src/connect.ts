/**
 * The connect flow's pure parts (#45): PKCE, the signed anti-CSRF `state`,
 * the authorization URL, and location discovery.
 *
 * The dashboard owns the I/O (KV nonce, the database row, redirects); this
 * module owns the crypto and the shapes so they are unit-tested without a
 * browser or a database.
 *
 * `state` is `base64url(payload).base64url(HMAC-SHA256(payload))` over
 * `{ projectId, accountId, nonce, exp }`, keyed by `GOOGLE_OAUTH_STATE_SECRET`.
 * The signature proves the callback came from a connect we started; `exp`
 * bounds it to ten minutes; the `nonce` is stored single-use in KV with
 * the PKCE verifier, so a replayed callback — same state, same code — is
 * refused even inside the window.
 */

import { createGoogleClient, type GoogleClient } from "./client.js";
import {
  GOOGLE_BUSINESS_MANAGE_SCOPE,
  type GoogleEndpoints,
} from "./endpoints.js";
import {
  bareId,
  type ConnectionMetadata,
  type MappedLocation,
} from "./locations.js";
import type { GbpLocation } from "./schema.js";

/** How long a connect attempt stays valid (state `exp` and the KV nonce TTL). */
export const CONNECT_TTL_SECONDS = 10 * 60;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- PKCE ---------------------------------------------------------------------

/** RFC 7636 verifier: 32 random bytes, base64url (43 chars). */
export function generateCodeVerifier(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** `S256`: base64url(SHA-256(verifier)). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  return toBase64Url(new Uint8Array(digest));
}

/** A 128-bit random nonce, base64url. */
export function generateNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

// --- state ---------------------------------------------------------------------

export interface ConnectState {
  projectId: string;
  accountId: string;
  nonce: string;
  /** Unix seconds. */
  exp: number;
}

export class StateError extends Error {
  override readonly name = "StateError";
  constructor(readonly reason: "malformed" | "bad_signature" | "expired") {
    super(`OAuth state ${reason.replace("_", " ")}`);
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signState(
  secret: string,
  state: ConnectState,
): Promise<string> {
  const payload = encoder.encode(JSON.stringify(state));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    payload,
  );
  return `${toBase64Url(payload)}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Verify signature and expiry; throws {@link StateError}. */
export async function verifyState(
  secret: string,
  state: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ConnectState> {
  const dot = state.indexOf(".");
  if (dot <= 0 || dot === state.length - 1) throw new StateError("malformed");
  let payload: Uint8Array<ArrayBuffer>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    payload = fromBase64Url(state.slice(0, dot));
    signature = fromBase64Url(state.slice(dot + 1));
  } catch {
    throw new StateError("malformed");
  }
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    payload,
  );
  if (!ok) throw new StateError("bad_signature");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new StateError("malformed");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as ConnectState).projectId !== "string" ||
    typeof (parsed as ConnectState).accountId !== "string" ||
    typeof (parsed as ConnectState).nonce !== "string" ||
    typeof (parsed as ConnectState).exp !== "number"
  ) {
    throw new StateError("malformed");
  }
  const value = parsed as ConnectState;
  if (value.exp <= nowSeconds) throw new StateError("expired");
  return value;
}

// --- authorize URL -------------------------------------------------------------

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/**
 * The consent-screen URL: `business.manage` only, `access_type=offline` +
 * `prompt=consent` so Google issues a refresh token on every connect (it
 * withholds one on repeat consents otherwise), PKCE S256.
 */
export function buildAuthorizeUrl(
  endpoints: Pick<GoogleEndpoints, "authorizeUrl">,
  input: AuthorizeUrlInput,
): string {
  const url = new URL(endpoints.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_BUSINESS_MANAGE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    state: input.state,
  }).toString();
  return url.toString();
}

// --- discovery -------------------------------------------------------------------

export interface DiscoveredLocations {
  locations: MappedLocation[];
  /** Account display names by bare account id. */
  accounts: Record<string, string>;
}

/** One formatted address line; empty when Google sent none. */
export function formatAddress(
  address: GbpLocation["storefrontAddress"],
): string {
  if (!address) return "";
  const region = [address.administrativeArea, address.postalCode]
    .filter(Boolean)
    .join(" ");
  return [...(address.addressLines ?? []), address.locality, region]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join(", ");
}

/**
 * `accounts.list`, then `locations.list` per account, flattened into the
 * mapping shape with `enabled: false`. `verified` is
 * `metadata.hasVoiceOfMerchant === true` — the fake's signal; confirm the
 * real field when #44 lands (docs/google.md).
 */
export async function discoverLocations(
  client: Pick<GoogleClient, "listAccounts" | "listLocations">,
  accessToken: string,
): Promise<DiscoveredLocations> {
  const accounts = await client.listAccounts(accessToken);
  const out: DiscoveredLocations = { locations: [], accounts: {} };
  for (const account of accounts) {
    const accountId = bareId(account.name);
    out.accounts[accountId] = account.accountName ?? account.name;
    const locations = await client.listLocations(accessToken, account.name);
    for (const location of locations) {
      const mapped: MappedLocation = {
        id: bareId(location.name),
        account: accountId,
        title: location.title ?? location.name,
        address: formatAddress(location.storefrontAddress),
        verified: location.metadata?.hasVoiceOfMerchant === true,
        enabled: false,
      };
      if (location.metadata?.placeId)
        mapped.placeId = location.metadata.placeId;
      const category = location.categories?.primaryCategory?.name;
      if (category) mapped.primaryCategory = category;
      out.locations.push(mapped);
    }
  }
  return out;
}

/**
 * Re-discovery keeps the user's choices: a location that was enabled stays
 * enabled if it is still listed and still verified; one that vanished is
 * dropped (its reviews stay — the mapping only decides what is polled).
 */
export function mergeLocationMapping(
  existing: readonly MappedLocation[],
  discovered: readonly MappedLocation[],
): MappedLocation[] {
  const enabledBefore = new Set(
    existing.filter((l) => l.enabled).map((l) => l.id),
  );
  return discovered.map((l) => ({
    ...l,
    enabled: l.verified && enabledBefore.has(l.id),
  }));
}

/** Convenience for callers holding endpoints + fetch. */
export async function discoverWithEndpoints(
  endpoints: GoogleEndpoints,
  accessToken: string,
  fetchImpl?: typeof fetch,
): Promise<DiscoveredLocations> {
  return discoverLocations(
    createGoogleClient({ endpoints, fetch: fetchImpl }),
    accessToken,
  );
}

/** Apply the user's selection; unverified ids are never enabled. */
export function applyLocationSelection(
  metadata: ConnectionMetadata,
  enabledIds: readonly string[],
): MappedLocation[] {
  const wanted = new Set(enabledIds);
  return metadata.locations.map((l) => ({
    ...l,
    enabled: l.verified && wanted.has(l.id),
  }));
}
