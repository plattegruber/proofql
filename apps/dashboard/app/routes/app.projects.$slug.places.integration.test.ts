// The places resource route against the real schema (#47), in the local
// auth stub, with the fake Places API served over HTTP on a random port
// (PLACES_API_BASE) and a recording INGEST_QUEUE: search answers the
// fixtures; import writes the reviews, records the run and redirects to the
// onboarding's step 3 (or the Import tab's run page); the action refuses
// politely without a key.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { schema } from "@proofql/db";
import { account, project, setupTestDb } from "@proofql/db/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLoadContext } from "~/lib/context";
import {
  CEDAR_RIDGE_ID,
  fakePlacesApi,
  HARBOR_LIGHT_ID,
} from "../../test/fake-places";
import { failingQueue, fakeQueue } from "../../test/fake-r2";
import { action, type PlacesActionData } from "./app.projects.$slug.places";

const t = setupTestDb();

let server: Server;
let placesBase: string;
let slug: string;
let projectId: string;
const api = fakePlacesApi();

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined)
        headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
    const response = await api.fetch(`http://places.local${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(response.status, {
      "content-type": response.headers.get("content-type") ?? "",
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  placesBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const a = await account(t.db, { clerkOrgId: "org_places_route" });
  const p = await project(t.db, { accountId: a.id, slug: "cedar-ridge" });
  slug = p.slug;
  projectId = p.id;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function testEnv(overrides: Partial<Env> = {}) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${t.databaseName}`;
  const queue = fakeQueue();
  const env = {
    ENVIRONMENT: "local",
    API_URL: "http://localhost:8797",
    SNIPPET_SRC: "http://localhost:8800/v1.js",
    AUTH_STUB_ORG_ID: "org_places_route",
    CLERK_PUBLISHABLE_KEY: "",
    CLERK_SECRET_KEY: "",
    CLERK_WEBHOOK_SIGNING_SECRET: "",
    SESSION_SECRET: "",
    GOOGLE_PLACES_API_KEY: "fake",
    PLACES_API_BASE: placesBase,
    HYPERDRIVE: { connectionString: url.toString() } as Hyperdrive,
    INGEST_QUEUE: {
      sendBatch: queue.sendBatch,
    } as unknown as Queue,
    ...overrides,
  } as Env;
  return { env, queue };
}

async function post(form: Record<string, string>, env: Env) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const body = new URLSearchParams(form);
  const result = await action({
    request: new Request(`http://localhost:8799/app/projects/${slug}/places`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    params: { slug },
    context: createLoadContext({ env, ctx }),
  } as never);
  await Promise.all(pending);
  return result;
}

/** `data()` results carry the payload under `.data` and the init separately. */
function unwrap(result: unknown): { status: number; data: PlacesActionData } {
  const r = result as { data: PlacesActionData; init?: { status?: number } };
  return { status: r.init?.status ?? 200, data: r.data };
}

describe("places action", () => {
  it("search: answers the fixtures for the query", async () => {
    const { env } = testEnv();
    const result = unwrap(await post({ intent: "search", q: "dental" }, env));
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({
      intent: "search",
      query: "dental",
      cached: false,
    });
    if (!("matches" in result.data)) throw new Error("expected matches");
    expect(result.data.matches.map((m) => m.id)).toEqual([CEDAR_RIDGE_ID]);

    const short = unwrap(await post({ intent: "search", q: "ab" }, env));
    expect(short.status).toBe(400);
    expect(short.data).toEqual({
      intent: "search",
      error: "Type at least three characters of the business name.",
    });
  });

  it("import: writes the reviews, records a places run, enqueues, and redirects into onboarding step 3", async () => {
    const { env, queue } = testEnv();
    const before = api.calls.length;
    const result = (await post(
      { intent: "import", place_id: CEDAR_RIDGE_ID, onboarding: "1" },
      env,
    )) as Response;
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(302);
    const location = new URL(
      result.headers.get("Location") ?? "",
      "http://localhost:8799",
    );
    expect(location.pathname).toBe(`/app/onboarding/${slug}/indexing`);
    const runId = location.searchParams.get("run");
    expect(runId).toBeTruthy();

    const run = await t.db.query.ingestRuns.findFirst({
      where: eq(schema.ingestRuns.id, runId as string),
    });
    expect(run).toMatchObject({
      projectId,
      kind: "places",
      status: "succeeded",
      environment: "live",
      received: 5,
      created: 5,
      artifactKey: `places:${CEDAR_RIDGE_ID}`,
    });
    const reviews = await t.db.query.reviews.findMany({
      where: eq(schema.reviews.projectId, projectId),
    });
    expect(reviews).toHaveLength(5);
    expect(queue.messages).toHaveLength(5);
    expect(api.calls.slice(before).map((c) => c.path)).toEqual([
      `/v1/places/${CEDAR_RIDGE_ID}`,
    ]);

    // From the Import tab (no flag), into the run page, test environment,
    // and the same five rows are not duplicated.
    const again = (await post(
      { intent: "import", place_id: CEDAR_RIDGE_ID, environment: "test" },
      env,
    )) as Response;
    expect(again.status).toBe(302);
    expect(again.headers.get("Location")).toMatch(
      new RegExp(`^/app/projects/${slug}/import/[0-9a-f-]{36}$`),
    );
    const all = await t.db.query.reviews.findMany({
      where: eq(schema.reviews.projectId, projectId),
    });
    expect(all.filter((r) => r.environment === "test")).toHaveLength(5);
    expect(all).toHaveLength(10);
  });

  it("import: past the Queues daily limit still redirects to the run page; the run succeeds and the review waits for the sweep (#159)", async () => {
    const queue = failingQueue();
    const { env } = testEnv({
      INGEST_QUEUE: { sendBatch: queue.sendBatch } as unknown as Queue,
    });
    const result = (await post(
      { intent: "import", place_id: HARBOR_LIGHT_ID },
      env,
    )) as Response;
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(302);
    const location = result.headers.get("Location") ?? "";
    expect(location).toMatch(
      new RegExp(`^/app/projects/${slug}/import/[0-9a-f-]{36}$`),
    );
    expect(queue.attempts).toBe(1);

    const run = await t.db.query.ingestRuns.findFirst({
      where: eq(schema.ingestRuns.id, location.split("/").at(-1) as string),
    });
    expect(run).toMatchObject({ status: "succeeded", created: 1 });
    const harbor = (
      await t.db.query.reviews.findMany({
        where: eq(schema.reviews.projectId, projectId),
      })
    ).filter((r) => r.externalId.startsWith(`places/${HARBOR_LIGHT_ID}/`));
    expect(harbor).toHaveLength(1);
    expect(harbor[0]?.indexedAt).toBeNull();
  });

  it("import: a place with nothing to import, and a bad id, answer in the voice", async () => {
    const { env } = testEnv();
    const none = unwrap(
      await post({ intent: "import", place_id: "ChIJquietcorner000003" }, env),
    );
    expect(none.status).toBe(404);
    expect(none.data).toEqual({
      intent: "import",
      error: "Google shares no public reviews for Quiet Corner Books yet.",
    });
    const bad = unwrap(await post({ intent: "import", place_id: "x y" }, env));
    expect(bad.status).toBe(400);
    const unknown = unwrap(
      await post({ intent: "import", place_id: "ChIJnope" }, env),
    );
    expect(unknown.status).toBe(502);
    expect(unknown.data).toEqual({
      intent: "import",
      error: "Google no longer lists this place.",
    });
  });

  it("refuses with 503 when the key is not configured", async () => {
    const { env } = testEnv({ GOOGLE_PLACES_API_KEY: "" });
    const result = unwrap(await post({ intent: "search", q: "dental" }, env));
    expect(result.status).toBe(503);
    expect(result.data).toEqual({
      intent: "search",
      error: "Google Places is not configured in this environment.",
    });
  });
});
