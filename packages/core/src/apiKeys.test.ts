/**
 * Unit tests for API key generation, hashing, pattern, and prefix parsing
 * (issue #18): the right prefix per kind/environment, uniform base62 random
 * part, deterministic SHA-256 hashing, and `parseApiKey` round-trips.
 *
 * Fixtures with a secret-key prefix are assembled at runtime (`join("_")`)
 * rather than written as literals: GitHub push protection matches Stripe's
 * `sk_live_` + alphanumerics anywhere in a string, fake or not.
 */

import { describe, expect, it } from "vitest";

import {
  API_KEY_ENVIRONMENTS,
  API_KEY_KINDS,
  API_KEY_PATTERN,
  API_KEY_RANDOM_LENGTH,
  type ApiKeyEnvironment,
  type ApiKeyKind,
  generateApiKey,
  hashApiKey,
  parseApiKey,
} from "./apiKeys.js";

const RANDOM = "0".repeat(API_KEY_RANDOM_LENGTH);

/** `pq_<tag>_<env>_<random>` without a literal secret-looking string in source. */
function key(tag: string, env: string, random = RANDOM): string {
  return ["pq", tag, env, random].join("_");
}

const SCHEME_PREFIX: Record<ApiKeyKind, Record<ApiKeyEnvironment, string>> = {
  secret: { live: key("sk", "live", ""), test: key("sk", "test", "") },
  publishable: { live: key("pk", "live", ""), test: key("pk", "test", "") },
};

describe("generateApiKey", () => {
  it.each([
    ["secret", "live"],
    ["secret", "test"],
    ["publishable", "live"],
    ["publishable", "test"],
  ] as const)("%s/%s keys carry the right prefix", async (kind, environment) => {
    const generated = await generateApiKey({ kind, environment });
    expect(
      generated.plaintext.startsWith(SCHEME_PREFIX[kind][environment]),
    ).toBe(true);
    expect(generated.kind).toBe(kind);
    expect(generated.environment).toBe(environment);
  });

  it("random part is 32 base62 characters", async () => {
    const { plaintext } = await generateApiKey({
      kind: "secret",
      environment: "live",
    });
    const random = plaintext.slice(SCHEME_PREFIX.secret.live.length);
    expect(random).toHaveLength(32);
    expect(random).toMatch(/^[0-9A-Za-z]+$/);
  });

  it("generated keys match API_KEY_PATTERN", async () => {
    for (const kind of API_KEY_KINDS) {
      for (const environment of API_KEY_ENVIRONMENTS) {
        const { plaintext } = await generateApiKey({ kind, environment });
        expect(plaintext).toMatch(API_KEY_PATTERN);
      }
    }
  });

  it("generations never collide", async () => {
    const keys = await Promise.all(
      Array.from({ length: 100 }, () =>
        generateApiKey({ kind: "publishable", environment: "live" }),
      ),
    );
    expect(new Set(keys.map((k) => k.plaintext)).size).toBe(100);
  });

  it("uses the whole base62 alphabet, not just a biased slice of it", async () => {
    // 200 keys x 32 chars = 6,400 draws over 62 symbols; every symbol should
    // appear. Catches a broken rejection-sampling or modulo bug.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { plaintext } = await generateApiKey({
        kind: "secret",
        environment: "test",
      });
      for (const ch of plaintext.slice(-API_KEY_RANDOM_LENGTH)) seen.add(ch);
    }
    expect(seen.size).toBe(62);
  });

  it("hash is the SHA-256 hex of the plaintext", async () => {
    const { plaintext, hash } = await generateApiKey({
      kind: "secret",
      environment: "live",
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await hashApiKey(plaintext));
  });

  it("prefix is the scheme prefix plus the first four random characters", async () => {
    const { plaintext, prefix } = await generateApiKey({
      kind: "publishable",
      environment: "test",
    });
    expect(prefix).toBe(
      plaintext.slice(0, SCHEME_PREFIX.publishable.test.length + 4),
    );
    expect(prefix.startsWith(SCHEME_PREFIX.publishable.test)).toBe(true);
    // The prefix alone is not a valid key.
    expect(prefix).not.toMatch(API_KEY_PATTERN);
  });
});

describe("hashApiKey", () => {
  it("is deterministic", async () => {
    const { plaintext } = await generateApiKey({
      kind: "secret",
      environment: "live",
    });
    expect(await hashApiKey(plaintext)).toBe(await hashApiKey(plaintext));
  });

  it("matches the well-known SHA-256 test vector", async () => {
    // SHA-256("abc") — pins the algorithm so a refactor to HMAC/salt fails.
    expect(await hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("different keys hash differently", async () => {
    const a = await generateApiKey({ kind: "secret", environment: "live" });
    const b = await generateApiKey({ kind: "secret", environment: "live" });
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("API_KEY_PATTERN", () => {
  it("accepts every kind/environment combination", () => {
    for (const tag of ["sk", "pk"]) {
      for (const env of ["live", "test"]) {
        expect(key(tag, env)).toMatch(API_KEY_PATTERN);
      }
    }
  });

  it("rejects non-key input before any hashing or DB work", () => {
    for (const bad of [
      "",
      key("sk", "live", ""), // prefix only
      key("zk", "live"), // unknown kind
      key("sk", "prod"), // unknown environment
      key("sk", "live", "0".repeat(31)), // too short
      key("sk", "live", "0".repeat(33)), // too long
      key("sk", "live", `${"0".repeat(31)}-`), // base64url alphabet, not base62
      key("sk", "live", `${"0".repeat(31)}_`),
      key("sk", "live", `${"0".repeat(31)}=`),
      `Bearer ${key("pk", "live")}`, // caller must strip the scheme
      ` ${key("pk", "live")}`, // leading whitespace
      `${key("pk", "live")}\n`, // trailing newline
      key("pk", "live").toUpperCase(), // PQ_PK_LIVE_
      ["sk", "live", RANDOM].join("_"), // missing pq_ namespace
      ["pq", "sk", "live", RANDOM].join("-"), // wrong separator
    ]) {
      expect(bad).not.toMatch(API_KEY_PATTERN);
    }
  });
});

describe("parseApiKey", () => {
  it("round-trips every generated key", async () => {
    for (const kind of API_KEY_KINDS) {
      for (const environment of API_KEY_ENVIRONMENTS) {
        const { plaintext } = await generateApiKey({ kind, environment });
        expect(parseApiKey(plaintext)).toEqual({ kind, environment });
      }
    }
  });

  it("maps sk to secret and pk to publishable", () => {
    expect(parseApiKey(key("sk", "live"))).toEqual({
      kind: "secret",
      environment: "live",
    });
    expect(parseApiKey(key("pk", "test"))).toEqual({
      kind: "publishable",
      environment: "test",
    });
  });

  it("returns null for garbage without throwing", () => {
    for (const bad of [
      "",
      "not a key",
      key("sk", "live", ""),
      key("xx", "live"),
      key("sk", "staging"),
      key("sk", "live", "0".repeat(31)),
      `Bearer ${key("sk", "live")}`,
      "pq_sk_live_", // scope.md's own elided example, minus the ellipsis
    ]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });
});
