# API reference source

[`openapi.yaml`](openapi.yaml) is the OpenAPI 3.1 description of the public `/v1` API and the **source of truth** for it (epic #7, task #42). What the spec says the worker does, the worker does — the contract tests below make sure of it on every PR.

## The rule

**Change the code → change the spec in the same PR.** A response-shape, status, header, or validation change in `workers/api` lands together with the matching edit here. CI enforces it from both sides: the `lint` job lints the spec, the `integration` job runs the contract tests against the real worker. (The same sentence is in [CONTRIBUTING](../../CONTRIBUTING.md).)

## Rendered reference

The docs site ([`docs/site`](../site/README.md), #43) renders this file at `https://docs.proofql.dev/api` through `starlight-openapi`; nothing there is hand-written, so an edit here is the whole change. Its link check also holds `/errors` to the `ErrorCode` enum: every value needs an anchor on that page, because `doc_url` points there.

## Lint

```sh
pnpm openapi:lint      # Redocly CLI, config in /redocly.yaml; also part of `pnpm lint`
```

Rules: Redocly `recommended`, with every operation required to carry an `operationId`, enumerate its 4xx responses, declare its security, and leave no unused component. Deliberate exceptions live in [`/.redocly.lint-ignore.yaml`](../../.redocly.lint-ignore.yaml) with a reason each (`GET /health` and the CORS preflight have no 4xx of their own; the second server is `localhost`). Do not regenerate that file wholesale — add an entry with a comment, or fix the spec.

## Contract tests

[`workers/api/src/openapi.contract.integration.test.ts`](../../workers/api/src/openapi.contract.integration.test.ts) runs under `pnpm test:integration` (it needs the local Postgres; see CONTRIBUTING "Tests"). It boots the real app with `createApp` — the harness database, the deterministic fake embedder, a Map-backed KV, an on/off rate limiter — and issues real requests for every operation and every documented status that can be provoked:

| Status | How |
|---|---|
| 200 / 204 | the spec's own request examples (ingest, PATCH, query) and the happy paths (pagination, `?key=` + `Origin`, cache HIT/BYPASS, `mode=reviews`, no-`q`) |
| 401 | no key, malformed key, unknown key, secret key in `?key=` |
| 403 | publishable key on a secret-only route; publishable key with a missing or unlisted `Origin` on `/v1/query` |
| 404 | unknown id, non-UUID id, a review in the other environment |
| 413 | bodies over the 1 MiB / 64 KiB limits |
| 422 | invalid JSON, schema failures, unknown fields, bad cursor, `review_limit_reached` on a project at its cap |
| 429 | the injected limiter refusing (`rate_limited`); a project with a full `usage` row (`query_quota_exceeded`) |
| 500 | `POST /v1/reviews` with the ingest queue binding throwing |
| 503 | the fake embedder failing (`embedding_unavailable`) |

Every response is held to the spec: the status must be documented for the operation, every `required` header must be present, every present documented header must match its schema (`RateLimit-Limit` as an integer, `x-cache` in `HIT|MISS|BYPASS`, `Vary: Origin`, …), and the JSON body must match the response schema. Response schemas are closed (`additionalProperties: false`), so a field added in code fails here until the spec learns it. A `204` must have an empty body.

Two tests then close the loop on the spec itself:

- **Coverage** — every `(operation, status)` the spec documents was exercised by some test, except the `500`s on operations with no fault a test can inject (listed in the test). A status nobody can get cannot be documented.
- **Examples** — every `example`/`examples` in the spec (request bodies, parameters, responses, schema `examples`) is valid against its own schema. The happy-path tests also send the request examples to the real routes, so they are known to be accepted, not just well-formed.

### Why Ajv and a ten-line resolver

OpenAPI 3.1 schemas *are* JSON Schema 2020-12, so [Ajv](https://ajv.js.org) (`Ajv2020` + `ajv-formats`) validates them directly. The only OpenAPI-specific plumbing is resolving `$ref`s: `components.schemas` is registered once as a single schema document and `#/components/schemas/X` is rewritten to point into it; `$ref`s to responses, headers, and parameters are followed with a small JSON-pointer helper. The dedicated OpenAPI response-validator packages either wrap an older Ajv with OpenAPI 3.0 assumptions (`nullable`, no `type: [a, "null"]`) or validate the document rather than responses, and none of them is lighter than three well-known dependencies in the api workspace's `devDependencies`.

### Adding a route or a status

1. Edit `openapi.yaml`: the operation, its responses (reuse `components/responses/*` for errors, `components/headers/*` for headers), and an example for the happy path.
2. Add a test that provokes each new status and calls `conforms(res, method, path)`. The coverage test will tell you which documented responses are still unexercised.
3. `pnpm openapi:lint`, then `DATABASE_URL=… pnpm test:integration`.
