/**
 * Serve the fake Places API (`@proofql/google/fake`, packages/google/src/
 * fake/places.ts) on a port for a manual run of the dashboard (#47) or of
 * the pipeline's refresh cron (#116):
 *
 *   pnpm build                                            # once: dist/ of @proofql/google
 *   node apps/dashboard/test/fake-places-server.ts        # port 8803
 *   PORT=9000 node apps/dashboard/test/fake-places-server.ts
 *
 * then in apps/dashboard/.dev.vars and workers/pipeline/.dev.vars:
 *
 *   GOOGLE_PLACES_API_KEY=fake
 *   PLACES_API_BASE=http://localhost:8803
 *
 * Plain Node (24+ strips the types itself); not a Worker, not part of any
 * test run — the tests take the handler in-process. Searching "dental",
 * "bakery", "books" or "boulder" finds the fixtures.
 */
import { createServer } from "node:http";

import { fakePlacesApi } from "@proofql/google/fake";

const port = Number(process.env.PORT ?? 8803);
const api = fakePlacesApi();

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(",") : value);
  }
  const response = await api.fetch(`http://localhost:${port}${req.url}`, {
    method,
    headers,
    body:
      method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
  res.writeHead(response.status, {
    "content-type": response.headers.get("content-type") ?? "application/json",
  });
  res.end(Buffer.from(await response.arrayBuffer()));
  process.stdout.write(`${method} ${req.url} → ${response.status}\n`);
});

server.listen(port, () => {
  process.stdout.write(`fake Places API on http://localhost:${port}\n`);
});
