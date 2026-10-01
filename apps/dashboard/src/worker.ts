/**
 * Wrangler entrypoint (see `main` in wrangler.jsonc). Placeholder until
 * React Router v7 on Workers lands in #36 and replaces this with the
 * framework's server entry. Typed against the DOM lib (react.json tsconfig),
 * not @cloudflare/workers-types, on purpose: the real app is a browser +
 * server codebase and #36 brings its own binding types.
 */

export default {
  fetch(_request: Request): Response {
    return new Response("ProofQL dashboard — placeholder until #36", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
