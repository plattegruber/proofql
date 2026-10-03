/**
 * Serve the fake Places API (fake-places.ts) on a port for a manual run of
 * the dashboard (#47):
 *
 *   node apps/dashboard/test/fake-places-server.ts        # port 8802
 *   PORT=9000 node apps/dashboard/test/fake-places-server.ts
 *
 * then in apps/dashboard/.dev.vars:
 *
 *   GOOGLE_PLACES_API_KEY=fake
 *   PLACES_API_BASE=http://localhost:8802
 *
 * Plain Node (24+ strips the types itself); not a Worker, not part of any
 * test run. Searching "dental", "bakery", "books" or "boulder" finds the
 * fixtures.
 */
import { createServer } from "node:http";

// Node's ESM loader needs the `.ts` extension; tsc does not allow it in a
// literal import, so resolve it at runtime and keep the type.
const { fakePlacesApi } = (await import(
  new URL("./fake-places.ts", import.meta.url).href
)) as typeof import("./fake-places");

const port = Number(process.env.PORT ?? 8802);
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
