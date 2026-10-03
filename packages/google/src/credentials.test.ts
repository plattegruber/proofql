import { describe, expect, it } from "vitest";

import {
  accessTokenExpiresWithin,
  CREDENTIALS_FORMAT_VERSION,
  CredentialsError,
  decryptCredentials,
  encryptCredentials,
  type GoogleCredentials,
  importCredentialsKey,
} from "./credentials.js";

function randomKey(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  );
}

const creds: GoogleCredentials = {
  access_token: "ya29.access",
  refresh_token: "1//refresh",
  expiry: "2026-10-01T12:00:00.000Z",
};

describe("credentials", () => {
  it("round-trips through the v1 format with a fresh iv each time", async () => {
    const key = await importCredentialsKey(randomKey());
    const a = await encryptCredentials(key, creds);
    const b = await encryptCredentials(key, creds);
    expect(a.startsWith(`${CREDENTIALS_FORMAT_VERSION}:`)).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain("ya29");
    expect(a).not.toContain("refresh");
    expect(await decryptCredentials(key, a)).toEqual(creds);
    expect(await decryptCredentials(key, b)).toEqual(creds);
  });

  it("rejects a tampered ciphertext, iv, or version prefix", async () => {
    const key = await importCredentialsKey(randomKey());
    const stored = await encryptCredentials(key, creds);
    const [v, iv, ct] = stored.split(":") as [string, string, string];

    const flip = (s: string) => {
      const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      bytes[0] = (bytes[0] as number) ^ 0xff;
      return btoa(String.fromCharCode(...bytes));
    };
    await expect(
      decryptCredentials(key, `${v}:${iv}:${flip(ct)}`),
    ).rejects.toMatchObject({
      name: "CredentialsError",
      reason: "decrypt_failed",
    });
    await expect(
      decryptCredentials(key, `${v}:${flip(iv)}:${ct}`),
    ).rejects.toMatchObject({
      reason: "decrypt_failed",
    });
    await expect(
      decryptCredentials(key, `v2:${iv}:${ct}`),
    ).rejects.toMatchObject({
      reason: "bad_format",
    });
    await expect(decryptCredentials(key, "garbage")).rejects.toBeInstanceOf(
      CredentialsError,
    );
  });

  it("rejects the wrong key", async () => {
    const stored = await encryptCredentials(
      await importCredentialsKey(randomKey()),
      creds,
    );
    await expect(
      decryptCredentials(await importCredentialsKey(randomKey()), stored),
    ).rejects.toMatchObject({ reason: "decrypt_failed" });
  });

  it("refuses a missing, non-base64, or wrong-length key", async () => {
    await expect(importCredentialsKey(undefined)).rejects.toMatchObject({
      reason: "bad_key",
    });
    await expect(importCredentialsKey("")).rejects.toMatchObject({
      reason: "bad_key",
    });
    await expect(importCredentialsKey("not*base64")).rejects.toMatchObject({
      reason: "bad_key",
    });
    await expect(
      importCredentialsKey(btoa(String.fromCharCode(...new Uint8Array(16)))),
    ).rejects.toMatchObject({ reason: "bad_key" });
  });

  it("knows when the access token is about to expire", () => {
    const now = Date.parse("2026-10-01T11:56:00Z");
    expect(accessTokenExpiresWithin(creds, 5 * 60_000, now)).toBe(true);
    expect(accessTokenExpiresWithin(creds, 60_000, now)).toBe(false);
  });
});
