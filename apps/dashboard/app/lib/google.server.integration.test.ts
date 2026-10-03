/**
 * The Google connect flow end to end against the real schema and the fake
 * Google server on an ephemeral port: the connect route 302s to the fake's
 * consent screen, the fake 302s back with a code, the callback verifies the
 * state and single-use nonce, exchanges the code, stores AES-GCM ciphertext
 * and the discovered locations; a replayed callback is refused; saving the
 * picker enqueues `connection.sync`; disconnecting clears the credentials
 * and keeps the reviews. Runs in the local auth stub.
 */

import { schema } from "@proofql/db";
import { DEMO_ACCOUNT_CLERK_ORG_ID } from "@proofql/db/seed";
import { account, project, review, setupTestDb } from "@proofql/db/test";
import {
  decryptCredentials,
  importCredentialsKey,
  parseConnectionMetadata,
} from "@proofql/google";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLoadContext } from "~/lib/context";
import { loader as callback } from "~/routes/app.integrations.google.callback";
import {
  action as integrationsAction,
  loader as integrationsLoader,
} from "~/routes/app.projects.$slug.integrations";
import { loader as connect } from "~/routes/app.projects.$slug.integrations.google.connect";
import {
  fakeGoogleEnv,
  type RunningFakeGoogle,
  startFakeGoogle,
} from "../../test/fake-google-server";
import { ConnectError, completeConnect } from "./google.server";

const t = setupTestDb();

const CREDENTIALS_KEY = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);

let demo: Awaited<ReturnType<typeof account>>;
let fake: RunningFakeGoogle;
beforeAll(async () => {
  demo = await account(t.db, { clerkOrgId: DEMO_ACCOUNT_CLERK_ORG_ID });
  fake = await startFakeGoogle();
});
afterAll(async () => {
  await fake.close();
});

/** A KV with the three methods the nonce store uses, recording deletes. */
class FakeKv {
  readonly store = new Map<string, { value: string; ttl?: number }>();
  readonly deletes: string[] = [];
  async get(key: string) {
    return this.store.get(key)?.value ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    this.store.set(key, { value, ttl: options?.expirationTtl });
  }
  async delete(key: string) {
    this.deletes.push(key);
    this.store.delete(key);
  }
}

/** Records `send` and `sendBatch`. */
class FakeQueue {
  readonly sent: unknown[] = [];
  async send(body: unknown) {
    this.sent.push(body);
  }
  async sendBatch(messages: Iterable<{ body: unknown }>) {
    for (const m of messages) this.sent.push(m.body);
  }
}

function testEnv(
  kv: FakeKv,
  queue: FakeQueue,
  overrides: Record<string, string> = {},
): Env {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${t.databaseName}`;
  return {
    ENVIRONMENT: "local",
    API_URL: "http://localhost:8797",
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_SECRET_KEY: "",
    CLERK_WEBHOOK_SIGNING_SECRET: "",
    SESSION_SECRET: "",
    CREDENTIALS_KEY,
    GOOGLE_OAUTH_STATE_SECRET: "test-state-secret",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_CONNECTOR_ENABLED: "true",
    ...fakeGoogleEnv(fake),
    CACHE: kv as unknown as KVNamespace,
    INGEST_QUEUE: queue as unknown as Queue,
    HYPERDRIVE: { connectionString: url.toString() } as Hyperdrive,
    ...overrides,
  } as Env;
}

function harness(overrides: Record<string, string> = {}) {
  const kv = new FakeKv();
  const queue = new FakeQueue();
  const env = testEnv(kv, queue, overrides);
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const context = () => createLoadContext({ env, ctx });
  const settle = () => Promise.all(pending);
  return { kv, queue, env, context, settle };
}

const ORIGIN = "https://dash.test";

async function startConnect(
  h: ReturnType<typeof harness>,
  slug: string,
): Promise<Response> {
  const result = await connect({
    request: new Request(
      `${ORIGIN}/app/projects/${slug}/integrations/google/connect`,
    ),
    params: { slug },
    context: h.context(),
  } as never);
  await h.settle();
  return result as Response;
}

/** Follow the 302 to the fake's consent screen and come back with the callback URL. */
async function consent(authorizeUrl: string): Promise<URL> {
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location") as string);
}

async function runCallback(
  h: ReturnType<typeof harness>,
  url: URL,
): Promise<Response> {
  const result = await callback({
    request: new Request(url),
    params: {},
    context: h.context(),
  } as never);
  await h.settle();
  return result as Response;
}

async function connection(projectId: string) {
  const [row] = await t.db
    .select()
    .from(schema.connections)
    .where(eq(schema.connections.projectId, projectId));
  return row;
}

describe("connect → callback", () => {
  it("stores encrypted credentials and the discovered locations, then lands on the tab", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "cedar" });
    const h = harness();

    const started = await startConnect(h, "cedar");
    expect(started.status).toBe(302);
    const authorize = new URL(started.headers.get("Location") as string);
    expect(authorize.origin).toBe(fake.origin);
    expect(authorize.pathname).toBe("/o/oauth2/v2/auth");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/app/integrations/google/callback`,
    );
    expect(authorize.searchParams.get("access_type")).toBe("offline");
    expect(authorize.searchParams.get("prompt")).toBe("consent");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    // The nonce is in KV with the ten-minute TTL and the verifier never left the server.
    const [nonceKey, record] = [...h.kv.store.entries()][0] as [
      string,
      { value: string; ttl?: number },
    ];
    expect(nonceKey).toMatch(/^oauth:/);
    expect(record.ttl).toBe(600);
    expect(JSON.parse(record.value)).toMatchObject({
      projectId: p.id,
      accountId: demo.id,
    });
    expect(authorize.toString()).not.toContain(
      JSON.parse(record.value).verifier,
    );

    const back = await consent(authorize.toString());
    expect(back.pathname).toBe("/app/integrations/google/callback");
    expect(back.searchParams.get("code")).toMatch(/^code_/);

    const landed = await runCallback(h, back);
    expect(landed.status).toBe(302);
    expect(landed.headers.get("Location")).toBe(
      "/app/projects/cedar/integrations",
    );
    expect(landed.headers.get("Set-Cookie")).toContain("__pq_flash=");
    expect(h.kv.deletes).toEqual([nonceKey]);

    const row = await connection(p.id);
    expect(row).toMatchObject({ kind: "google", status: "active" });
    expect(row?.credentials).toMatch(/^v1:/);
    expect(row?.credentials).not.toContain("at_");
    const creds = await decryptCredentials(
      await importCredentialsKey(CREDENTIALS_KEY),
      row?.credentials as string,
    );
    expect(fake.store.isAccessTokenValid(creds.access_token)).toBe(true);
    expect(creds.refresh_token).toMatch(/^rt_/);
    expect(Date.parse(creds.expiry)).toBeGreaterThan(Date.now());

    const metadata = parseConnectionMetadata(row?.metadata);
    expect(
      metadata.locations.map((l) => [l.id, l.verified, l.enabled]),
    ).toEqual([
      ["201", true, false],
      ["202", true, false],
      ["203", false, false],
    ]);
    expect(metadata.locations[0]).toMatchObject({
      account: "100",
      title: "Cedar Ridge Dental — North",
      address: "1420 Cedar Ridge Pkwy, Boulder, CO 80301",
      placeId: "ChIJnorth0000000000000001",
    });
    expect(metadata.accounts).toEqual({ "100": "Cedar Ridge Dental Group" });
    expect(metadata.discovered_at).toBeDefined();

    // The tab's loader sees it.
    const view = (await integrationsLoader({
      request: new Request(`${ORIGIN}/app/projects/cedar/integrations`),
      params: { slug: "cedar" },
      context: h.context(),
    } as never)) as Awaited<ReturnType<typeof integrationsLoader>>;
    expect(view.connectorEnabled).toBe(true);
    expect(view.connection?.status).toBe("active");
    expect(view.connection?.locations).toHaveLength(3);
  });

  it("refuses a replayed callback (same state, same code) and never calls Google again", async () => {
    await project(t.db, { accountId: demo.id, slug: "replay" });
    const h = harness();
    const back = await consent(
      (await startConnect(h, "replay")).headers.get("Location") as string,
    );
    expect((await runCallback(h, back)).status).toBe(302);
    const tokenCalls = fake.store.requests.length;

    const replay = await runCallback(h, back);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("Location")).toBe(
      "/app/projects/replay/integrations",
    );
    // A negative flash, nothing written, no Google traffic.
    expect(replay.headers.get("Set-Cookie")).toContain("__pq_flash=");
    expect(fake.store.requests.length).toBe(tokenCalls);
  });

  it("rejects a tampered state, a foreign account, and a connect without offline access", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "tamper" });
    const h = harness();
    const back = await consent(
      (await startConnect(h, "tamper")).headers.get("Location") as string,
    );
    const tampered = new URL(back);
    tampered.searchParams.set("state", `${back.searchParams.get("state")}x`);
    const result = await runCallback(h, tampered);
    expect(result.status).toBe(302);
    expect(await connection(p.id)).toBeUndefined();

    // Direct call: another account's id in the signed state is refused before KV.
    const other = await account(t.db);
    await expect(
      completeConnect({
        env: h.env,
        kv: h.kv,
        db: t.db,
        code: "x",
        state: back.searchParams.get("state") as string,
        accountId: other.id,
        redirectUri: "x",
      }),
    ).rejects.toMatchObject({
      name: "ConnectError",
      reason: "account_mismatch",
    });

    // A consent that omits offline access yields no refresh token: nothing stored.
    const noOffline = new URL(back);
    const authorize = new URL(
      (await startConnect(h, "tamper")).headers.get("Location") as string,
    );
    authorize.searchParams.delete("prompt");
    const withoutRefresh = await consent(authorize.toString());
    const refused = await completeConnect({
      env: h.env,
      kv: h.kv,
      db: t.db,
      code: withoutRefresh.searchParams.get("code") as string,
      state: withoutRefresh.searchParams.get("state") as string,
      accountId: demo.id,
      redirectUri: `${ORIGIN}/app/integrations/google/callback`,
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConnectError);
    expect((refused as ConnectError).reason).toBe("no_refresh_token");
    expect(await connection(p.id)).toBeUndefined();
    void noOffline;
  });

  it("a denied consent lands back on the tab with a negative flash and writes nothing", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "denied" });
    const h = harness();
    const authorize = new URL(
      (await startConnect(h, "denied")).headers.get("Location") as string,
    );
    const denied = new URL(`${ORIGIN}/app/integrations/google/callback`);
    denied.searchParams.set("error", "access_denied");
    denied.searchParams.set(
      "state",
      authorize.searchParams.get("state") as string,
    );
    const result = await runCallback(h, denied);
    expect(result.headers.get("Location")).toBe(
      "/app/projects/denied/integrations",
    );
    expect(await connection(p.id)).toBeUndefined();
  });

  it("reconnecting replaces the credentials and keeps the enabled locations", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "again" });
    const h = harness();
    await runCallback(
      h,
      await consent(
        (await startConnect(h, "again")).headers.get("Location") as string,
      ),
    );
    await saveLocations(h, "again", ["201"]);
    const before = await connection(p.id);
    // Simulate the poller having marked it dead.
    await t.db
      .update(schema.connections)
      .set({ status: "needs_reauth", credentials: null })
      .where(eq(schema.connections.id, before?.id as string));

    await runCallback(
      h,
      await consent(
        (await startConnect(h, "again")).headers.get("Location") as string,
      ),
    );
    const after = await connection(p.id);
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe("active");
    expect(after?.credentials).toMatch(/^v1:/);
    expect(
      parseConnectionMetadata(after?.metadata).locations.find(
        (l) => l.id === "201",
      )?.enabled,
    ).toBe(true);
  });
});

async function saveLocations(
  h: ReturnType<typeof harness>,
  slug: string,
  ids: string[],
) {
  const body = new URLSearchParams([
    ["intent", "save-locations"],
    ...ids.map((id) => ["location", id]),
  ]);
  const result = await integrationsAction({
    request: new Request(`${ORIGIN}/app/projects/${slug}/integrations`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
    params: { slug },
    context: h.context(),
  } as never);
  await h.settle();
  return result as Response;
}

describe("location mapping and disconnect", () => {
  it("saving enabled locations sets initial_sync_pending and enqueues connection.sync", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "map" });
    const h = harness();
    await runCallback(
      h,
      await consent(
        (await startConnect(h, "map")).headers.get("Location") as string,
      ),
    );

    const saved = await saveLocations(h, "map", ["201", "203", "999"]);
    expect(saved.status).toBe(302);
    expect(saved.headers.get("Set-Cookie")).toContain("__pq_flash=");
    const row = await connection(p.id);
    const metadata = parseConnectionMetadata(row?.metadata);
    // 203 is unverified and 999 unknown: neither can be enabled.
    expect(metadata.locations.map((l) => [l.id, l.enabled])).toEqual([
      ["201", true],
      ["202", false],
      ["203", false],
    ]);
    expect(metadata.initial_sync_pending).toBe(true);
    expect(h.queue.sent).toEqual([
      { type: "connection.sync", connectionId: row?.id, projectId: p.id },
    ]);

    // Deselecting everything: saved, no sync message.
    await saveLocations(h, "map", []);
    expect(h.queue.sent).toHaveLength(1);
    expect(
      parseConnectionMetadata(
        (await connection(p.id))?.metadata,
      ).locations.every((l) => !l.enabled),
    ).toBe(true);
  });

  it("disconnecting clears the credentials, keeps the mapping and the reviews", async () => {
    const p = await project(t.db, { accountId: demo.id, slug: "bye" });
    const h = harness();
    await runCallback(
      h,
      await consent(
        (await startConnect(h, "bye")).headers.get("Location") as string,
      ),
    );
    await saveLocations(h, "bye", ["201"]);
    await review(t.db, {
      projectId: p.id,
      source: "google",
      externalId: "accounts/100/locations/201/reviews/x",
    });

    const result = (await integrationsAction({
      request: new Request(`${ORIGIN}/app/projects/bye/integrations`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "disconnect" }),
      }),
      params: { slug: "bye" },
      context: h.context(),
    } as never)) as Response;
    await h.settle();
    expect(result.status).toBe(302);

    const row = await connection(p.id);
    expect(row?.status).toBe("disconnected");
    expect(row?.credentials).toBeNull();
    expect(
      parseConnectionMetadata(row?.metadata).locations.find(
        (l) => l.id === "201",
      )?.enabled,
    ).toBe(true);
    const reviews = await t.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.projectId, p.id));
    expect(reviews).toHaveLength(1);

    // The tab shows "not connected" again; saving locations is refused.
    const view = (await integrationsLoader({
      request: new Request(`${ORIGIN}/app/projects/bye/integrations`),
      params: { slug: "bye" },
      context: h.context(),
    } as never)) as Awaited<ReturnType<typeof integrationsLoader>>;
    expect(view.connection?.status).toBe("disconnected");
    await expect(saveLocations(h, "bye", ["201"])).rejects.toMatchObject({
      init: { status: 409 },
    });
  });

  it("the connect route refuses to start while the connector is switched off", async () => {
    await project(t.db, { accountId: demo.id, slug: "dark" });
    const h = harness({ GOOGLE_CONNECTOR_ENABLED: "false" });
    await expect(startConnect(h, "dark")).rejects.toMatchObject({
      init: { status: 503 },
    });
    const view = (await integrationsLoader({
      request: new Request(`${ORIGIN}/app/projects/dark/integrations`),
      params: { slug: "dark" },
      context: h.context(),
    } as never)) as Awaited<ReturnType<typeof integrationsLoader>>;
    expect(view.connectorEnabled).toBe(false);
  });
});
