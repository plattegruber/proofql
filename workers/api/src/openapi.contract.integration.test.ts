/**
 * Contract tests for docs/api/openapi.yaml (#42): the spec is the source of
 * truth for the public API, and this file is what makes that true.
 *
 * The real app (`createApp` with the harness database, the deterministic
 * fake embedder, a Map-backed KV, and an on/off rate limiter) is driven
 * through every documented operation and every documented status that can
 * be provoked — 200/204 happy paths, 401/403/404/413/422/429, 503 via an
 * embedder failure, and 500 via a queue outage on ingest. Each response is
 * then held to the spec:
 *
 *   - the status must be documented for that operation;
 *   - every documented header that is `required` must be present, and every
 *     documented header that is present must match its schema;
 *   - a JSON body must match the response schema (closed schemas, so a new
 *     field in the code fails here until the spec learns it); a `204` must
 *     have no body.
 *
 * Two more tests close the loop: every documented `(operation, status)` was
 * exercised (so the spec cannot describe a response nobody can get), and
 * every example in the spec — request bodies, parameters, responses — is
 * valid against its own schema (so the examples a developer copies are the
 * shapes the server accepts).
 *
 * Validator: Ajv (2020-12 draft, which is what OpenAPI 3.1 schemas are) plus
 * ajv-formats, with a one-line `$ref` rewrite so `#/components/schemas/X`
 * resolves inside a single registered schema document. Nothing OpenAPI-
 * specific is needed beyond that, which is why no dedicated OpenAPI
 * response validator is pulled in (see docs/api/README.md).
 *
 * Happy-path request bodies are the spec's own examples, so the examples
 * are also proven acceptable by the real routes, not only by the schema.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FakeEmbeddingProvider, fakeEmbed } from "@proofql/ai";
import { generateApiKey, recordingSink } from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import {
  account,
  chunk,
  type Project,
  project,
  review,
  setupTestDb,
} from "@proofql/db/test";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { fakeCtx, fakeKv, issueKey, testEnv } from "../test/helpers.js";
import { createApp } from "./app.js";
import type { ApiBindings, AppEnv } from "./bindings.js";
import { monthStart } from "./quota.js";
import { QUERY_BODY_LIMIT_BYTES } from "./request-guards.js";
import { REVIEW_BODY_LIMIT_BYTES } from "./routes/reviews.js";
import { PATCH_BODY_LIMIT_BYTES } from "./routes/reviews-crud.js";

// ---------------------------------------------------------------------------
// The spec, and a resolver over it

const SPEC_PATH = fileURLToPath(
  new URL("../../../docs/api/openapi.yaml", import.meta.url),
);

type Json = Record<string, unknown>;
interface Ref {
  $ref: string;
}
interface MediaType {
  schema: Json;
  example?: unknown;
  examples?: Record<string, { value: unknown }>;
}
interface HeaderObject {
  required?: boolean;
  schema?: Json;
}
interface ResponseObject {
  headers?: Record<string, HeaderObject | Ref>;
  content?: Record<string, MediaType>;
}
interface ParameterObject {
  name: string;
  in: string;
  schema?: Json;
  example?: unknown;
  examples?: Record<string, { value: unknown }>;
}
interface Operation {
  parameters?: (ParameterObject | Ref)[];
  requestBody?: { content: Record<string, MediaType> } | Ref;
  responses: Record<string, ResponseObject | Ref>;
}
type Method = "get" | "post" | "patch" | "delete" | "options";
const METHODS: readonly Method[] = [
  "get",
  "post",
  "patch",
  "delete",
  "options",
];
type PathItem = Partial<Record<Method, Operation>> & {
  parameters?: (ParameterObject | Ref)[];
};
interface OpenApiDoc {
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, Json> };
}

const spec = parseYaml(readFileSync(SPEC_PATH, "utf8")) as OpenApiDoc;

function isRef(value: unknown): value is Ref {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Ref).$ref === "string"
  );
}

/** Follow a `#/a/b~1c` JSON pointer inside the document. */
function pointer(ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`external $ref: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((node, key) => {
      if (typeof node !== "object" || node === null || !(key in node)) {
        throw new Error(`unresolvable $ref: ${ref}`);
      }
      return (node as Json)[key];
    }, spec);
}

/** Resolve a (possibly chained) `$ref` to the object it names. */
function deref<T>(node: T | Ref): T {
  let current: unknown = node;
  const seen = new Set<string>();
  while (isRef(current)) {
    if (seen.has(current.$ref))
      throw new Error(`$ref cycle at ${current.$ref}`);
    seen.add(current.$ref);
    current = pointer(current.$ref);
  }
  return current as T;
}

function operation(method: Method, path: string): Operation {
  const op = spec.paths[path]?.[method];
  if (op === undefined) throw new Error(`spec has no ${method} ${path}`);
  return op;
}

// ---------------------------------------------------------------------------
// Ajv over the spec's schemas

/**
 * `components.schemas` is registered once as one JSON Schema document whose
 * `$defs` are the components; every `#/components/schemas/X` reference in
 * any schema we compile is rewritten to point into it. That is the whole
 * "resolver".
 */
const SCHEMAS_ID = "urn:proofql:openapi:schemas";
const schemasDocument = {
  $id: SCHEMAS_ID,
  $defs: rewriteRefs(spec.components.schemas),
};

function rewriteRefs<T>(node: T): T {
  return JSON.parse(
    JSON.stringify(node).replaceAll(
      '"#/components/schemas/',
      `"${SCHEMAS_ID}#/$defs/`,
    ),
  ) as T;
}

function makeAjv(options: { coerceTypes?: boolean }): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
    // Header values arrive as strings; the header validator coerces them to
    // the schema's type (`RateLimit-Limit: 300` is an integer in the spec).
    ...(options.coerceTypes ? { coerceTypes: true } : {}),
  });
  addFormats(ajv);
  ajv.addSchema(schemasDocument);
  return ajv;
}

const bodyAjv = makeAjv({});
const headerAjv = makeAjv({ coerceTypes: true });
const compiled = new Map<string, ValidateFunction>();

function validatorFor(
  ajv: Ajv2020,
  kind: string,
  schema: Json,
): ValidateFunction {
  const key = `${kind}:${JSON.stringify(schema)}`;
  let fn = compiled.get(key);
  if (fn === undefined) {
    fn = ajv.compile(rewriteRefs(schema));
    compiled.set(key, fn);
  }
  return fn;
}

function assertValid(
  validate: ValidateFunction,
  data: unknown,
  label: string,
): void {
  const ok = validate(data);
  if (!ok) {
    const problems = (validate.errors ?? [])
      .map(
        (e) =>
          `  ${e.instancePath || "/"} ${e.message ?? ""} ${JSON.stringify(e.params)}`,
      )
      .join("\n");
    expect.fail(
      `${label} does not match the spec:\n${problems}\n\nvalue: ${JSON.stringify(data, null, 2)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The contract check

/** Every `(method path status)` a test has validated; see "coverage" below. */
const exercised = new Set<string>();

/**
 * Assert that `res` is a response the spec documents for `method path`:
 * status, headers, and body. Returns the parsed JSON body (or undefined).
 */
async function conforms(
  res: Response,
  method: Method,
  path: string,
): Promise<unknown> {
  const op = operation(method, path);
  const status = String(res.status);
  const label = `${method.toUpperCase()} ${path} → ${status}`;
  const documented = op.responses[status];
  expect(
    documented,
    `${label}: the spec documents no ${status} response (has ${Object.keys(op.responses).join(", ")})`,
  ).toBeDefined();
  const response = deref<ResponseObject>(documented as ResponseObject | Ref);
  exercised.add(`${method} ${path} ${status}`);

  for (const [name, headerOrRef] of Object.entries(response.headers ?? {})) {
    const header = deref<HeaderObject>(headerOrRef);
    const value = res.headers.get(name);
    if (header.required) {
      expect(
        value,
        `${label}: required header ${name} is missing`,
      ).not.toBeNull();
    }
    if (value !== null && header.schema !== undefined) {
      assertValid(
        validatorFor(headerAjv, "header", header.schema),
        value,
        `${label}: header ${name}`,
      );
    }
  }

  if (response.content === undefined) {
    expect(await res.text(), `${label}: documented without a body`).toBe("");
    return undefined;
  }
  const media = response.content["application/json"];
  if (media === undefined) throw new Error(`${label}: no application/json`);
  expect(res.headers.get("content-type")).toMatch(/^application\/json\b/);
  const body: unknown = await res.json();
  assertValid(
    validatorFor(bodyAjv, "body", media.schema),
    body,
    `${label}: body`,
  );
  return body;
}

/** The spec's request-body examples for an operation, by name. */
function requestExamples(
  method: Method,
  path: string,
): Record<string, unknown> {
  const body = operation(method, path).requestBody;
  if (body === undefined)
    throw new Error(`${method} ${path} has no requestBody`);
  const media = deref<{ content: Record<string, MediaType> }>(body).content[
    "application/json"
  ];
  if (media === undefined)
    throw new Error(`${method} ${path}: no application/json`);
  return Object.fromEntries(
    Object.entries(media.examples ?? {}).map(([name, ex]) => [name, ex.value]),
  );
}

// ---------------------------------------------------------------------------
// Fixture: the app with switchable failure modes, and a project with data

const t = setupTestDb();

const ORIGIN = "https://shop.example";
const UNLISTED_ORIGIN = "https://evil.example";

/** Flip to provoke 429 / 503 on the next request. Reset after each use. */
const fault = { refuseRateLimit: false, embeddingDown: false };

const kv = fakeKv();
/** Accepting queue: ingest happy paths enqueue the pipeline message. */
const env = testEnv({
  kv,
  queue: {
    send: async () => {},
    sendBatch: async () => {},
  } as unknown as ApiBindings["INGEST_QUEUE"],
});
/** Refusing queue (the helper default): a queue outage is a 500 on ingest. */
const envQueueDown = testEnv({ kv });

let app: Hono<AppEnv>;

interface Fixture {
  project: Project;
  secret: string;
  publishable: string;
  /** A test-environment key for the same project (sees no live rows). */
  secretTest: string;
  /** Ids of indexed, publishable reviews. */
  implant: string;
  /** A longer review with a `window` chunk (#85 highlight). */
  whitening: string;
  /** A project at its monthly query quota. */
  quotaSecret: string;
  /** A project at its review cap. */
  cappedSecret: string;
}
let f: Fixture;

const IMPLANT = "My implant feels like my own tooth.";
const CLEANING = "Painless cleaning, very gentle hygienist.";
const PARKING = "Parking behind the building was easy.";
/** Emoji before the matching sentence: UTF-16 offsets differ from code points. */
const WHITENING =
  "😀 Love this place!! The whitening results were amazing. Booking online was easy.";
const WHITENING_WINDOW = "The whitening results were amazing.";

function embed(text: string): number[] {
  const [vector] = fakeEmbed([text]);
  if (vector === undefined) throw new Error("fakeEmbed returned nothing");
  return vector;
}

async function indexed(
  db: Db,
  projectId: string,
  text: string,
  overrides: Parameters<typeof review>[1] = {},
): Promise<string> {
  const r = await review(db, { projectId, text, ...overrides });
  await chunk(db, {
    reviewId: r.id,
    kind: "full",
    text,
    startOffset: 0,
    embedding: embed(text),
  });
  return r.id;
}

beforeAll(async () => {
  app = createApp({
    db: t.db,
    // Log lines go to a recorder, not the console: the contract is in the
    // responses, and 40 tests' worth of JSON lines would bury a failure.
    logSink: recordingSink().sink,
    embedder: new FakeEmbeddingProvider({
      shouldFail: () =>
        fault.embeddingDown ? new Error("Workers AI is down") : undefined,
    }),
    rateLimiter: {
      limit: async () => ({ success: !fault.refuseRateLimit }),
    },
  });

  const p = await project(t.db, {
    allowedOrigins: [ORIGIN],
    minRating: 4,
    similarityFloor: 0.55,
    showBadge: true,
  });
  const implant = await indexed(t.db, p.id, IMPLANT, {
    rating: 5,
    source: "google",
    occurredAt: new Date("2026-03-01T00:00:00Z"),
    metadata: { location: "north" },
    url: "https://maps.google.com/implant",
  });
  await indexed(t.db, p.id, CLEANING, {
    rating: 4,
    source: "yelp",
    occurredAt: new Date("2026-02-01T00:00:00Z"),
    metadata: { location: "south" },
  });
  await indexed(t.db, p.id, PARKING, {
    rating: 5,
    occurredAt: new Date("2026-01-01T00:00:00Z"),
  });
  const whitening = await indexed(t.db, p.id, WHITENING, {
    rating: 5,
    source: "google",
    occurredAt: new Date("2025-12-01T00:00:00Z"),
  });
  await chunk(t.db, {
    reviewId: whitening,
    kind: "window",
    text: WHITENING_WINDOW,
    startOffset: WHITENING.indexOf(WHITENING_WINDOW),
    embedding: embed(WHITENING_WINDOW),
  });
  // An unrated review with no model sentiment yet, and a dateless one, so
  // the nullable columns of ReviewResource are exercised by the list.
  await review(t.db, {
    projectId: p.id,
    rating: null,
    sentiment: null,
    sentimentSource: null,
    occurredAt: null,
    language: null,
  });

  const quotaAccount = await account(t.db, { plan: "free" });
  const quotaProject = await project(t.db, { accountId: quotaAccount.id });
  await t.db.insert(schema.usage).values({
    projectId: quotaProject.id,
    month: monthStart(),
    queries: 50_000,
    cacheHits: 0,
  });
  const capped = await project(t.db, { reviewCount: 5_000 });

  f = {
    project: p,
    secret: (await issueKey(t.db, p.id, "secret")).plaintext,
    publishable: (await issueKey(t.db, p.id, "publishable")).plaintext,
    secretTest: (await issueKey(t.db, p.id, "secret", "test")).plaintext,
    implant,
    whitening,
    quotaSecret: (await issueKey(t.db, quotaProject.id, "secret")).plaintext,
    cappedSecret: (await issueKey(t.db, capped.id, "secret")).plaintext,
  };
});

interface CallOptions {
  method?: string;
  key?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body (not JSON-encoded), e.g. an oversized string. */
  rawBody?: string;
  env?: ApiBindings;
}

/** One request through the real app, with post-response work flushed. */
async function call(
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.key !== undefined)
    headers.authorization = `Bearer ${options.key}`;
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
  }
  const ctx = fakeCtx();
  const res = await app.request(
    path,
    {
      method: options.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
    },
    options.env ?? env,
    ctx.asExecutionContext(),
  );
  await ctx.flush();
  return res;
}

/** Run `fn` with a fault switched on, and switch it off again afterwards. */
async function withFault<T>(
  name: keyof typeof fault,
  fn: () => Promise<T>,
): Promise<T> {
  fault[name] = true;
  try {
    return await fn();
  } finally {
    fault[name] = false;
  }
}

async function unknownKey(kind: "secret" | "publishable"): Promise<string> {
  return (await generateApiKey({ kind, environment: "live" })).plaintext;
}

const RANDOM_UUID = "00000000-0000-4000-8000-000000000000";

// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("200", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    await conforms(res, "get", "/health");
  });
});

describe("POST /v1/reviews", () => {
  const PATH = "/v1/reviews";

  it("200: the spec's own request examples are accepted and the response matches", async () => {
    for (const [name, example] of Object.entries(
      requestExamples("post", PATH),
    )) {
      const res = await call(PATH, {
        method: "POST",
        key: f.secret,
        body: example,
      });
      expect(res.status, `example "${name}"`).toBe(200);
      const body = (await conforms(res, "post", PATH)) as {
        reviews: { status: string }[];
      };
      const count = Array.isArray(example) ? example.length : 1;
      expect(body.reviews).toHaveLength(count);
      expect(body.reviews.every((r) => r.status === "indexing")).toBe(true);
    }
  });

  it("401: missing, malformed, and unknown keys", async () => {
    const single = requestExamples("post", PATH).single;
    for (const headers of [
      {},
      { authorization: "Basic abc" },
      { authorization: "Bearer not-a-key" },
      { authorization: `Bearer ${await unknownKey("secret")}` },
    ]) {
      const res = await call(PATH, { method: "POST", headers, body: single });
      expect(res.status).toBe(401);
      await conforms(res, "post", PATH);
    }
  });

  it("403: a publishable key", async () => {
    const res = await call(PATH, {
      method: "POST",
      key: f.publishable,
      body: requestExamples("post", PATH).single,
    });
    expect(res.status).toBe(403);
    await conforms(res, "post", PATH);
  });

  it("413: a body over the limit", async () => {
    const res = await call(PATH, {
      method: "POST",
      key: f.secret,
      headers: { "content-length": String(REVIEW_BODY_LIMIT_BYTES + 1) },
      rawBody: "x".repeat(REVIEW_BODY_LIMIT_BYTES + 1),
    });
    expect(res.status).toBe(413);
    await conforms(res, "post", PATH);
  });

  it("415: a body that is not application/json, before any key lookup", async () => {
    for (const contentType of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
    ]) {
      const res = await call(PATH, {
        method: "POST",
        key: f.secret,
        headers: { "content-type": contentType },
        body: requestExamples("post", PATH).single,
      });
      expect(res.status, contentType).toBe(415);
      const body = (await conforms(res, "post", PATH)) as {
        error: { code: string };
      };
      expect(body.error.code).toBe("unsupported_media_type");
      expect(res.headers.get("RateLimit-Limit")).toBeNull();
    }
  });

  it("422: validation_failed (invalid JSON, schema, unknown field) and review_limit_reached", async () => {
    const invalid = [
      { rawBody: "{not json" },
      { body: { source: "google" } },
      { body: [] },
      { body: { ...(requestExamples("post", PATH).single as Json), extra: 1 } },
    ];
    for (const variant of invalid) {
      const res = await call(PATH, {
        method: "POST",
        key: f.secret,
        ...variant,
      });
      expect(res.status).toBe(422);
      const body = (await conforms(res, "post", PATH)) as {
        error: { code: string };
      };
      expect(body.error.code).toBe("validation_failed");
    }

    const capped = await call(PATH, {
      method: "POST",
      key: f.cappedSecret,
      body: requestExamples("post", PATH).single,
    });
    expect(capped.status).toBe(422);
    const body = (await conforms(capped, "post", PATH)) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("review_limit_reached");
  });

  it("429: rate limited", async () => {
    const res = await withFault("refuseRateLimit", () =>
      call(PATH, {
        method: "POST",
        key: f.secret,
        body: requestExamples("post", PATH).single,
      }),
    );
    expect(res.status).toBe(429);
    await conforms(res, "post", PATH);
  });

  it("500: the ingest queue is down", async () => {
    const res = await call(PATH, {
      method: "POST",
      key: f.secret,
      env: envQueueDown,
      body: {
        ...(requestExamples("post", PATH).single as Json),
        external_id: "queue-down-new-review",
      },
    });
    expect(res.status).toBe(500);
    await conforms(res, "post", PATH);
  });
});

describe("GET /v1/reviews", () => {
  const PATH = "/v1/reviews";

  it("200: pages through the project with the documented cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs = cursor === null ? "limit=2" : `limit=2&cursor=${cursor}`;
      const res = await call(`${PATH}?${qs}`, { key: f.secret });
      expect(res.status).toBe(200);
      const body = (await conforms(res, "get", PATH)) as {
        reviews: { id: string }[];
        next_cursor: string | null;
      };
      seen.push(...body.reviews.map((r) => r.id));
      cursor = body.next_cursor;
      pages++;
    } while (cursor !== null && pages < 20);
    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(f.implant);
  });

  it("200: every documented filter is accepted", async () => {
    const res = await call(
      `${PATH}?source=google&min_rating=4&hidden=false&since=2025-01-01&indexed=true&limit=100`,
      { key: f.secret },
    );
    expect(res.status).toBe(200);
    await conforms(res, "get", PATH);
  });

  it("401 / 403", async () => {
    const anon = await call(PATH);
    expect(anon.status).toBe(401);
    await conforms(anon, "get", PATH);

    const pk = await call(PATH, { key: f.publishable });
    expect(pk.status).toBe(403);
    await conforms(pk, "get", PATH);
  });

  it("422: bad limit, bad cursor, unknown parameter", async () => {
    for (const qs of [
      "limit=0",
      "cursor=!!!",
      "cursor=bm90LWEtY3Vyc29y",
      "limt=3",
    ]) {
      const res = await call(`${PATH}?${qs}`, { key: f.secret });
      expect(res.status, qs).toBe(422);
      await conforms(res, "get", PATH);
    }
  });

  it("429", async () => {
    const res = await withFault("refuseRateLimit", () =>
      call(PATH, { key: f.secret }),
    );
    expect(res.status).toBe(429);
    await conforms(res, "get", PATH);
  });
});

describe("GET /v1/reviews/{id}", () => {
  const PATH = "/v1/reviews/{id}";

  it("200", async () => {
    const res = await call(`/v1/reviews/${f.implant}`, { key: f.secret });
    expect(res.status).toBe(200);
    const body = (await conforms(res, "get", PATH)) as { id: string };
    expect(body.id).toBe(f.implant);
  });

  it("401 / 403", async () => {
    const anon = await call(`/v1/reviews/${f.implant}`);
    expect(anon.status).toBe(401);
    await conforms(anon, "get", PATH);

    const pk = await call(`/v1/reviews/${f.implant}`, { key: f.publishable });
    expect(pk.status).toBe(403);
    await conforms(pk, "get", PATH);
  });

  it("404: unknown id, non-uuid id, and another environment's review", async () => {
    for (const [id, key] of [
      [RANDOM_UUID, f.secret],
      ["not-a-uuid", f.secret],
      [f.implant, f.secretTest],
    ] as const) {
      const res = await call(`/v1/reviews/${id}`, { key });
      expect(res.status, id).toBe(404);
      await conforms(res, "get", PATH);
    }
  });

  it("429", async () => {
    const res = await withFault("refuseRateLimit", () =>
      call(`/v1/reviews/${f.implant}`, { key: f.secret }),
    );
    expect(res.status).toBe(429);
    await conforms(res, "get", PATH);
  });
});

describe("PATCH /v1/reviews/{id}", () => {
  const PATH = "/v1/reviews/{id}";

  it("200: the spec's own request examples are accepted", async () => {
    const r = await review(t.db, {
      projectId: f.project.id,
      text: "Patch me.",
    });
    for (const [name, example] of Object.entries(
      requestExamples("patch", PATH),
    )) {
      const res = await call(`/v1/reviews/${r.id}`, {
        method: "PATCH",
        key: f.secret,
        body: example,
      });
      expect(res.status, `example "${name}"`).toBe(200);
      await conforms(res, "patch", PATH);
    }
    // And a no-op body (already hidden) still returns the resource.
    const again = await call(`/v1/reviews/${r.id}`, {
      method: "PATCH",
      key: f.secret,
      body: { hidden: true },
    });
    expect(again.status).toBe(200);
    const body = (await conforms(again, "patch", PATH)) as { hidden: boolean };
    expect(body.hidden).toBe(true);
  });

  it("401 / 403 / 404", async () => {
    const anon = await call(`/v1/reviews/${f.implant}`, {
      method: "PATCH",
      body: { hidden: true },
    });
    expect(anon.status).toBe(401);
    await conforms(anon, "patch", PATH);

    const pk = await call(`/v1/reviews/${f.implant}`, {
      method: "PATCH",
      key: f.publishable,
      body: { hidden: true },
    });
    expect(pk.status).toBe(403);
    await conforms(pk, "patch", PATH);

    const missing = await call(`/v1/reviews/${RANDOM_UUID}`, {
      method: "PATCH",
      key: f.secret,
      body: { hidden: true },
    });
    expect(missing.status).toBe(404);
    await conforms(missing, "patch", PATH);
  });

  it("413", async () => {
    const res = await call(`/v1/reviews/${f.implant}`, {
      method: "PATCH",
      key: f.secret,
      headers: { "content-length": String(PATCH_BODY_LIMIT_BYTES + 1) },
      rawBody: "x".repeat(PATCH_BODY_LIMIT_BYTES + 1),
    });
    expect(res.status).toBe(413);
    await conforms(res, "patch", PATH);
  });

  it("415: a non-JSON body", async () => {
    const res = await call(`/v1/reviews/${f.implant}`, {
      method: "PATCH",
      key: f.secret,
      headers: { "content-type": "text/plain" },
      body: { hidden: true },
    });
    expect(res.status).toBe(415);
    await conforms(res, "patch", PATH);
  });

  it("422: empty body, wrong types, nested metadata", async () => {
    for (const variant of [
      { body: {} },
      { body: { hidden: "yes" } },
      { body: { metadata: { nested: { a: 1 } } } },
      { rawBody: "{" },
    ]) {
      const res = await call(`/v1/reviews/${f.implant}`, {
        method: "PATCH",
        key: f.secret,
        ...variant,
      });
      expect(res.status).toBe(422);
      await conforms(res, "patch", PATH);
    }
  });

  it("429", async () => {
    const res = await withFault("refuseRateLimit", () =>
      call(`/v1/reviews/${f.implant}`, {
        method: "PATCH",
        key: f.secret,
        body: { hidden: false },
      }),
    );
    expect(res.status).toBe(429);
    await conforms(res, "patch", PATH);
  });
});

describe("DELETE /v1/reviews/{id}", () => {
  const PATH = "/v1/reviews/{id}";

  it("204, then 404 for the same id", async () => {
    const r = await review(t.db, {
      projectId: f.project.id,
      text: "Delete me.",
    });
    const res = await call(`/v1/reviews/${r.id}`, {
      method: "DELETE",
      key: f.secret,
    });
    expect(res.status).toBe(204);
    await conforms(res, "delete", PATH);

    const gone = await call(`/v1/reviews/${r.id}`, {
      method: "DELETE",
      key: f.secret,
    });
    expect(gone.status).toBe(404);
    await conforms(gone, "delete", PATH);
  });

  it("401 / 403 / 429", async () => {
    const anon = await call(`/v1/reviews/${f.implant}`, { method: "DELETE" });
    expect(anon.status).toBe(401);
    await conforms(anon, "delete", PATH);

    const pk = await call(`/v1/reviews/${f.implant}`, {
      method: "DELETE",
      key: f.publishable,
    });
    expect(pk.status).toBe(403);
    await conforms(pk, "delete", PATH);

    const limited = await withFault("refuseRateLimit", () =>
      call(`/v1/reviews/${f.implant}`, { method: "DELETE", key: f.secret }),
    );
    expect(limited.status).toBe(429);
    await conforms(limited, "delete", PATH);
  });
});

describe("GET /v1/query (the snippet's path)", () => {
  const PATH = "/v1/query";

  it("200: publishable key in ?key= from a listed origin; cached on repeat", async () => {
    const url = `${PATH}?key=${f.publishable}&q=implant+tooth&limit=3`;
    const first = await call(url, {
      headers: { origin: ORIGIN, "cache-control": "no-cache" },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBe("BYPASS");
    expect(first.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const body = (await conforms(first, "get", PATH)) as {
      results: {
        score: number | null;
        review: { id: string; text?: string };
      }[];
      cached: boolean;
      badge: boolean;
    };
    expect(body.results.map((r) => r.review.id)).toEqual([f.implant]);
    expect(body.results[0]?.score).toBeGreaterThanOrEqual(0.55);
    expect(body.results[0]?.review).not.toHaveProperty("text");
    expect(body.badge).toBe(true);

    const second = await call(url, { headers: { origin: ORIGIN } });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("HIT");
    const cached = (await conforms(second, "get", PATH)) as { cached: boolean };
    expect(cached.cached).toBe(true);
  });

  it("200: without q every score is null; every documented parameter is accepted", async () => {
    const res = await call(
      `${PATH}?limit=5&mode=reviews&min_rating=4&source=google,yelp&source=custom&since=2025-01-01&metadata.location=north`,
      { key: f.secret, headers: { "cache-control": "no-cache" } },
    );
    expect(res.status).toBe(200);
    const body = (await conforms(res, "get", PATH)) as {
      results: { score: number | null; review: { text?: string } }[];
    };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.every((r) => r.score === null)).toBe(true);
    expect(body.results.every((r) => typeof r.review.text === "string")).toBe(
      true,
    );
  });

  it("200: highlight is the excerpt's UTF-16 span in review.text; null for a whole-review match (#85)", async () => {
    const res = await call(
      `${PATH}?key=${f.publishable}&q=whitening+results&include=text&limit=3`,
      { headers: { origin: ORIGIN, "cache-control": "no-cache" } },
    );
    expect(res.status).toBe(200);
    const body = (await conforms(res, "get", PATH)) as {
      results: {
        excerpt: string;
        highlight: { start: number; end: number } | null;
        review: { id: string; text?: string };
      }[];
    };
    expect(body.results.map((r) => r.review.id)).toEqual([f.whitening]);
    const [top] = body.results;
    const start = WHITENING.indexOf(WHITENING_WINDOW);
    expect(top?.excerpt).toBe(WHITENING_WINDOW);
    expect(top?.highlight).toEqual({
      start,
      end: start + WHITENING_WINDOW.length,
    });
    // The verbatim invariant, end to end, with an emoji ahead of the span.
    expect(
      top?.review.text?.slice(start, start + WHITENING_WINDOW.length),
    ).toBe(WHITENING_WINDOW);

    const full = await call(`${PATH}?q=implant+tooth&limit=3`, {
      key: f.secret,
      headers: { "cache-control": "no-cache" },
    });
    const fullBody = (await conforms(full, "get", PATH)) as {
      results: { highlight: unknown; review: { text?: string } }[];
    };
    expect(fullBody.results[0]?.highlight).toBeNull();
    expect(fullBody.results[0]?.review).not.toHaveProperty("text");
  });

  it("401: no key, a secret key in the URL, an unknown publishable key", async () => {
    for (const url of [
      `${PATH}?q=implant`,
      `${PATH}?key=${f.secret}&q=implant`,
      `${PATH}?key=${await unknownKey("publishable")}&q=implant`,
    ]) {
      const res = await call(url, { headers: { origin: ORIGIN } });
      expect(res.status, url).toBe(401);
      await conforms(res, "get", PATH);
    }
  });

  it("403: publishable key with no Origin, or an unlisted one", async () => {
    for (const headers of [{}, { origin: UNLISTED_ORIGIN }]) {
      const res = await call(`${PATH}?key=${f.publishable}&q=implant`, {
        headers,
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      await conforms(res, "get", PATH);
    }
  });

  it("422: unknown parameter, bad limit, blank q, repeated parameter", async () => {
    for (const qs of [
      "limt=3",
      "limit=0",
      "limit=abc",
      "q=%20",
      "q=a&q=b",
      "mode=nope",
      "include=html",
    ]) {
      const res = await call(`${PATH}?${qs}`, { key: f.secret });
      expect(res.status, qs).toBe(422);
      await conforms(res, "get", PATH);
    }
  });

  it("429: rate_limited, and query_quota_exceeded on a cache miss at quota", async () => {
    const limited = await withFault("refuseRateLimit", () =>
      call(`${PATH}?q=implant`, { key: f.secret }),
    );
    expect(limited.status).toBe(429);
    const a = (await conforms(limited, "get", PATH)) as {
      error: { code: string };
    };
    expect(a.error.code).toBe("rate_limited");

    const quota = await call(`${PATH}?q=implant`, {
      key: f.quotaSecret,
      headers: { "cache-control": "no-cache" },
    });
    expect(quota.status).toBe(429);
    const b = (await conforms(quota, "get", PATH)) as {
      error: { code: string };
    };
    expect(b.error.code).toBe("query_quota_exceeded");
  });

  it("503: the embedder is down", async () => {
    const res = await withFault("embeddingDown", () =>
      call(`${PATH}?key=${f.publishable}&q=implant+tooth+now`, {
        headers: { origin: ORIGIN, "cache-control": "no-cache" },
      }),
    );
    expect(res.status).toBe(503);
    await conforms(res, "get", PATH);
  });
});

describe("POST /v1/query", () => {
  const PATH = "/v1/query";

  it("200: the spec's own request examples are accepted and the response matches", async () => {
    for (const [name, example] of Object.entries(
      requestExamples("post", PATH),
    )) {
      const res = await call(PATH, {
        method: "POST",
        key: f.secret,
        body: example,
        headers: { "cache-control": "no-cache" },
      });
      expect(res.status, `example "${name}"`).toBe(200);
      await conforms(res, "post", PATH);
    }
  });

  it("200: a publishable key from a listed origin, mode=reviews, empty body", async () => {
    const res = await call(PATH, {
      method: "POST",
      key: f.publishable,
      headers: { origin: ORIGIN, "cache-control": "no-cache" },
      body: {
        q: "gentle hygienist",
        mode: "reviews",
        filters: { source: "yelp" },
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const body = (await conforms(res, "post", PATH)) as {
      results: { excerpt: string; review: { text?: string } }[];
    };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]?.review.text).toBe(CLEANING);

    const empty = await call(PATH, {
      method: "POST",
      key: f.secret,
      headers: { "content-type": "application/json" },
      rawBody: "",
    });
    expect(empty.status).toBe(200);
    await conforms(empty, "post", PATH);
  });

  it("401 / 403", async () => {
    const anon = await call(PATH, { method: "POST", body: {} });
    expect(anon.status).toBe(401);
    await conforms(anon, "post", PATH);

    // #91: `?key=` is GET-only; on POST it is refused before any lookup,
    // even from a listed origin.
    const keyInUrl = await call(`${PATH}?key=${f.publishable}`, {
      method: "POST",
      headers: { origin: ORIGIN },
      body: {},
    });
    expect(keyInUrl.status).toBe(401);
    await conforms(keyInUrl, "post", PATH);

    const noOrigin = await call(PATH, {
      method: "POST",
      key: f.publishable,
      body: {},
    });
    expect(noOrigin.status).toBe(403);
    await conforms(noOrigin, "post", PATH);
  });

  it("413 / 415: a body over 16 KiB, and a body that is not JSON", async () => {
    const big = await call(PATH, {
      method: "POST",
      key: f.secret,
      headers: { "content-length": String(QUERY_BODY_LIMIT_BYTES + 1) },
      rawBody: "x".repeat(QUERY_BODY_LIMIT_BYTES + 1),
    });
    expect(big.status).toBe(413);
    await conforms(big, "post", PATH);

    const form = await call(PATH, {
      method: "POST",
      key: f.secret,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      rawBody: "q=implant",
    });
    expect(form.status).toBe(415);
    const body = (await conforms(form, "post", PATH)) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("unsupported_media_type");
  });

  it("422: invalid JSON, unknown field, out-of-range values", async () => {
    for (const variant of [
      { rawBody: "{" },
      { body: { limt: 3 } },
      { body: { limit: 21 } },
      { body: { q: "" } },
      { body: { filters: { min_rating: 6 } } },
      { body: { filters: { since: "yesterday" } } },
      { body: { filters: { metadata: { a: 1 } } } },
    ]) {
      const res = await call(PATH, {
        method: "POST",
        key: f.secret,
        ...variant,
      });
      expect(res.status, JSON.stringify(variant)).toBe(422);
      await conforms(res, "post", PATH);
    }
  });

  it("429 / 503", async () => {
    const limited = await withFault("refuseRateLimit", () =>
      call(PATH, { method: "POST", key: f.secret, body: {} }),
    );
    expect(limited.status).toBe(429);
    await conforms(limited, "post", PATH);

    const down = await withFault("embeddingDown", () =>
      call(PATH, {
        method: "POST",
        key: f.secret,
        headers: { "cache-control": "no-cache" },
        body: { q: "implant tooth later" },
      }),
    );
    expect(down.status).toBe(503);
    await conforms(down, "post", PATH);
  });
});

describe("OPTIONS /v1/query", () => {
  const PATH = "/v1/query";

  it("204 with the allow-origin echoed for a listed origin, and without it otherwise", async () => {
    const listed = await call(`${PATH}?key=${f.publishable}`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });
    expect(listed.status).toBe(204);
    expect(listed.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    await conforms(listed, "options", PATH);

    const unlisted = await call(`${PATH}?key=${f.publishable}`, {
      method: "OPTIONS",
      headers: { origin: UNLISTED_ORIGIN },
    });
    expect(unlisted.status).toBe(204);
    expect(unlisted.headers.get("access-control-allow-origin")).toBeNull();
    await conforms(unlisted, "options", PATH);
  });
});

// ---------------------------------------------------------------------------
// The spec against itself

describe("the spec", () => {
  it("documents no response that the tests above could not provoke", () => {
    // 500 is documented on every operation because any of them can fail
    // unexpectedly; only ingest has a fault (the queue) a test can inject.
    const untriggerable = new Set([
      "get /v1/reviews 500",
      "get /v1/reviews/{id} 500",
      "patch /v1/reviews/{id} 500",
      "delete /v1/reviews/{id} 500",
      "get /v1/query 500",
      "post /v1/query 500",
    ]);
    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (op === undefined) continue;
        for (const status of Object.keys(op.responses)) {
          const key = `${method} ${path} ${status}`;
          if (!exercised.has(key) && !untriggerable.has(key)) missing.push(key);
        }
      }
    }
    expect(missing, "documented but never exercised").toEqual([]);
    for (const key of untriggerable) {
      expect(spec.paths, key).toBeDefined();
    }
  });

  it("every example is valid against its schema", () => {
    let checked = 0;
    const check = (
      ajv: Ajv2020,
      schemaish: Json,
      value: unknown,
      label: string,
    ) => {
      assertValid(validatorFor(ajv, "example", schemaish), value, label);
      checked++;
    };
    const parameterExamples = (
      params: (ParameterObject | Ref)[] | undefined,
      label: string,
    ) => {
      for (const paramOrRef of params ?? []) {
        const param = deref<ParameterObject>(paramOrRef);
        if (param.schema === undefined) continue;
        const where = `${label} parameter ${param.name}`;
        if ("example" in param)
          check(headerAjv, param.schema, param.example, where);
        for (const [name, ex] of Object.entries(param.examples ?? {})) {
          check(headerAjv, param.schema, ex.value, `${where} example ${name}`);
        }
      }
    };
    const mediaExamples = (
      content: Record<string, MediaType> | undefined,
      label: string,
    ) => {
      for (const [type, media] of Object.entries(content ?? {})) {
        const where = `${label} ${type}`;
        if ("example" in media)
          check(bodyAjv, media.schema, media.example, where);
        for (const [name, ex] of Object.entries(media.examples ?? {})) {
          check(bodyAjv, media.schema, ex.value, `${where} example ${name}`);
        }
      }
    };

    for (const [path, item] of Object.entries(spec.paths)) {
      parameterExamples(item.parameters, path);
      for (const method of METHODS) {
        const op = item[method];
        if (op === undefined) continue;
        const label = `${method.toUpperCase()} ${path}`;
        parameterExamples(op.parameters, label);
        if (op.requestBody !== undefined) {
          const body = deref<{ content: Record<string, MediaType> }>(
            op.requestBody,
          );
          mediaExamples(body.content, `${label} request`);
        }
        for (const [status, responseOrRef] of Object.entries(op.responses)) {
          const response = deref<ResponseObject>(responseOrRef);
          mediaExamples(response.content, `${label} ${status}`);
        }
      }
    }
    for (const [name, schemaObject] of Object.entries(
      spec.components.schemas,
    )) {
      const examples = schemaObject.examples;
      if (!Array.isArray(examples)) continue;
      for (const [i, value] of examples.entries()) {
        check(
          bodyAjv,
          { $ref: `#/components/schemas/${name}` },
          value,
          `schema ${name} examples[${i}]`,
        );
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});
