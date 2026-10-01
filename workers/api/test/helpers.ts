/**
 * Shared fixtures for the api worker's tests (#74): a Map-backed KV, the
 * `ApiBindings` object `app.request()` takes as `env`, a recording
 * `ExecutionContext`, and a real API key row. Nothing here touches a
 * database by itself; `issueKey` takes the harness `Db` it should write to.
 */

import {
  type ApiKeyEnvironment,
  type ApiKeyKind,
  generateApiKey,
  type IngestMessage,
} from "@proofql/core";
import type { Db } from "@proofql/db";
import { apiKey } from "@proofql/db/test";

import type { ApiBindings } from "../src/bindings.js";

export interface FakeKvEntry {
  value: string;
  metadata: unknown;
  /** Epoch ms, or null for an entry without `expirationTtl`. */
  expiresAt: number | null;
}

export interface FakeKvOptions {
  /** The clock `expirationTtl` is measured against; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * The slice of `KVNamespace` the worker uses — `get`, `getWithMetadata`,
 * `put` (with `expirationTtl` and `metadata`), `delete` — over a Map, with
 * expiry honoured against an injectable clock so TTL behaviour is testable
 * without waiting. `store` is exposed for assertions; `asBinding()` is the
 * cast for `ApiBindings.CACHE`.
 */
export function fakeKv(options: FakeKvOptions = {}) {
  const now = options.now ?? Date.now;
  const store = new Map<string, FakeKvEntry>();

  const live = (key: string): FakeKvEntry | undefined => {
    const entry = store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  const kv = {
    store,
    get: async (key: string): Promise<string | null> =>
      live(key)?.value ?? null,
    getWithMetadata: async (key: string) => {
      const entry = live(key);
      return {
        value: entry?.value ?? null,
        metadata: entry?.metadata ?? null,
        cacheStatus: null,
      };
    },
    put: async (
      key: string,
      value: string,
      putOptions: { expirationTtl?: number; metadata?: unknown } = {},
    ): Promise<void> => {
      store.set(key, {
        value,
        metadata: putOptions.metadata ?? null,
        expiresAt:
          putOptions.expirationTtl !== undefined
            ? now() + putOptions.expirationTtl * 1000
            : null,
      });
    },
    delete: async (key: string): Promise<void> => {
      store.delete(key);
    },
    /** Stored string for `key` (ignoring expiry), or null. */
    peek: (key: string): string | null => store.get(key)?.value ?? null,
    asBinding: (): KVNamespace => kv as unknown as KVNamespace,
  };
  return kv;
}

export type FakeKv = ReturnType<typeof fakeKv>;

/** A queue binding that refuses every call — for routes that must not enqueue. */
export function refusingQueue(
  reason = "this route must not enqueue",
): Queue<IngestMessage> {
  return {
    send: async () => {
      throw new Error(reason);
    },
    sendBatch: async () => {
      throw new Error(reason);
    },
  } as unknown as Queue<IngestMessage>;
}

export interface TestEnvOptions {
  /** Defaults to a fresh `fakeKv()`. */
  kv?: FakeKv;
  /** Defaults to `refusingQueue()`. */
  queue?: Queue<IngestMessage>;
}

/** The `env` for `app.request()`: every binding present, none of them real. */
export function testEnv(options: TestEnvOptions = {}): ApiBindings {
  return {
    ENVIRONMENT: "test",
    HYPERDRIVE: { connectionString: "postgres://unused" } as Hyperdrive,
    CACHE: (options.kv ?? fakeKv()).asBinding(),
    INGEST_QUEUE: options.queue ?? refusingQueue(),
  };
}

/**
 * An `ExecutionContext` that records `waitUntil` promises so a test can
 * `await ctx.flush()` before asserting on post-response work (usage
 * counters, cache writes).
 */
export function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    pending,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
    flush: () => Promise.allSettled(pending),
    asExecutionContext: (): ExecutionContext =>
      ctx as unknown as ExecutionContext,
  };
  return ctx;
}

export type FakeCtx = ReturnType<typeof fakeCtx>;

/** A real key row for `projectId`, returning the plaintext to send. */
export async function issueKey(
  db: Db,
  projectId: string,
  kind: ApiKeyKind = "secret",
  environment: ApiKeyEnvironment = "live",
) {
  const generated = await generateApiKey({ kind, environment });
  const row = await apiKey(db, {
    projectId,
    kind,
    environment,
    keyHash: generated.hash,
    prefix: generated.prefix,
  });
  return { plaintext: generated.plaintext, row };
}
