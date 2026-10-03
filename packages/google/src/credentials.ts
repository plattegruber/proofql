/**
 * At-rest encryption for `connections.credentials` (scope.md §4;
 * docs/secrets.md `CREDENTIALS_KEY`).
 *
 * AES-256-GCM over WebCrypto only — the same code runs in workerd and under
 * Vitest. The key is 32 random bytes, base64 (`openssl rand -base64 32`),
 * identical in every worker that touches the table (pipeline, dashboard).
 *
 * Wire format, versioned so a future key or algorithm change can read old
 * rows: `v1:<base64 iv (12 bytes)>:<base64 ciphertext+tag>`. The version
 * prefix is also bound into the GCM additional data, so a ciphertext cannot
 * be replayed under a different version label. Tampering with any part —
 * iv, ciphertext, tag, prefix — fails decryption with
 * {@link CredentialsError}; so does a wrong key.
 *
 * The plaintext is the token JSON `{ access_token, refresh_token, expiry }`
 * (`expiry` ISO 8601). It is never logged: the logger redacts `plaintext`,
 * and callers log connection ids, never tokens.
 */

import { z } from "zod";

export const CREDENTIALS_FORMAT_VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class CredentialsError extends Error {
  override readonly name = "CredentialsError";
  constructor(
    message: string,
    readonly reason:
      | "bad_key"
      | "bad_format"
      | "decrypt_failed"
      | "bad_plaintext",
  ) {
    super(message);
  }
}

export const googleCredentialsSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  /** ISO 8601 instant the access token stops working. */
  expiry: z.iso.datetime({ offset: true }),
});
export type GoogleCredentials = z.infer<typeof googleCredentialsSchema>;

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new CredentialsError("not base64", "bad_format");
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Import `CREDENTIALS_KEY` (base64, exactly 32 bytes) as an AES-GCM key. */
export async function importCredentialsKey(
  base64Key: string | undefined,
): Promise<CryptoKey> {
  if (!base64Key || base64Key.trim().length === 0) {
    throw new CredentialsError("CREDENTIALS_KEY is not set", "bad_key");
  }
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(base64Key.trim());
  } catch {
    throw new CredentialsError("CREDENTIALS_KEY is not base64", "bad_key");
  }
  if (raw.length !== KEY_BYTES) {
    throw new CredentialsError(
      `CREDENTIALS_KEY must decode to ${KEY_BYTES} bytes, got ${raw.length}`,
      "bad_key",
    );
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

const additionalData = new TextEncoder().encode(
  `proofql.connections.credentials.${CREDENTIALS_FORMAT_VERSION}`,
);

/** Encrypt the token JSON to the `v1:` wire format. */
export async function encryptCredentials(
  key: CryptoKey,
  credentials: GoogleCredentials,
): Promise<string> {
  const plaintext = new TextEncoder().encode(
    JSON.stringify(googleCredentialsSchema.parse(credentials)),
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    plaintext,
  );
  return `${CREDENTIALS_FORMAT_VERSION}:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

/** Decrypt a `v1:` string; throws {@link CredentialsError} on any defect. */
export async function decryptCredentials(
  key: CryptoKey,
  stored: string,
): Promise<GoogleCredentials> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== CREDENTIALS_FORMAT_VERSION) {
    throw new CredentialsError(
      "credentials are not in the v1 format",
      "bad_format",
    );
  }
  const iv = fromBase64(parts[1] as string);
  const ciphertext = fromBase64(parts[2] as string);
  if (iv.length !== IV_BYTES) {
    throw new CredentialsError("bad iv length", "bad_format");
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData },
      key,
      ciphertext,
    );
  } catch {
    throw new CredentialsError(
      "credentials failed to decrypt (wrong key or tampered)",
      "decrypt_failed",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new CredentialsError(
      "decrypted payload is not JSON",
      "bad_plaintext",
    );
  }
  const parsed = googleCredentialsSchema.safeParse(json);
  if (!parsed.success) {
    throw new CredentialsError(
      "decrypted payload is not a credential set",
      "bad_plaintext",
    );
  }
  return parsed.data;
}

/** Whether the access token is (about to be) expired. */
export function accessTokenExpiresWithin(
  credentials: Pick<GoogleCredentials, "expiry">,
  withinMs: number,
  now: number = Date.now(),
): boolean {
  return Date.parse(credentials.expiry) - now <= withinMs;
}
