/**
 * The fake Google server on a real ephemeral port for the dashboard's
 * integration tests. The route modules build their Google URLs from env
 * (`GOOGLE_API_BASE` & co.) and call the global `fetch`, so — unlike the
 * pipeline's tests, which inject `app.fetch` — the dashboard needs the fake
 * to be reachable over HTTP. A ~30-line Node adapter avoids a dependency on
 * `@hono/node-server`: each incoming request becomes a WHATWG `Request`,
 * the Hono app answers it, and the `Response` is written back.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createFakeGoogle, type FakeGoogle } from "@proofql/google/fake";

export interface RunningFakeGoogle extends FakeGoogle {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  origin: string;
  close(): Promise<void>;
}

export async function startFakeGoogle(
  options: Parameters<typeof createFakeGoogle>[0] = {},
): Promise<RunningFakeGoogle> {
  const fake = createFakeGoogle(options);
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const method = req.method ?? "GET";
    const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value))
        for (const v of value) headers.append(name, v);
    }
    const body =
      method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
    const response = await fake.app.fetch(
      new Request(url, { method, headers, body }),
    );
    res.statusCode = response.status;
    response.headers.forEach((value, name) => {
      res.setHeader(name, value);
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ...fake,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** The env values that point the dashboard at a running fake. */
export function fakeGoogleEnv(running: RunningFakeGoogle) {
  return {
    GOOGLE_OAUTH_BASE: running.origin,
    GOOGLE_TOKEN_URL: `${running.origin}/token`,
    GOOGLE_API_BASE: running.origin,
  };
}
