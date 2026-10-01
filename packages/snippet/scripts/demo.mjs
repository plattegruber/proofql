// `pnpm --filter @proofql/snippet demo`: rebuild and serve the package on
// http://localhost:3000 (an origin the seed allows) so demo/index.html can
// talk to the local API on 8797. Zero dependencies; not for production.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSnippet } from "./build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".css": "text/css; charset=utf-8",
};

await buildSnippet();

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path = normalize(decodeURIComponent(url.pathname)).replace(
    /^(\.\.[/\\])+/,
    "",
  );
  if (path === "/" || path === "\\") path = "/demo/index.html";
  if (path.endsWith("/")) path += "index.html";
  const file = join(root, path);
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": types[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(
    `demo: http://localhost:${port}/demo/  (api: http://localhost:8797)`,
  );
});
