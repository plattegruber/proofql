import { describe, expect, it } from "vitest";

import {
  type AssetSource,
  cacheControlFor,
  handleRequest,
  IMMUTABLE_CACHE_CONTROL,
  isImmutablePath,
  isSnippetPath,
  isVersionManifest,
  MUTABLE_CACHE_CONTROL,
  NO_STORE,
  readVersion,
  withCdnHeaders,
} from "./handler.js";

const ORIGIN = "https://cdn.proofql.test";
const MANIFEST = {
  version: "0.0.0",
  hash: "0123abcd",
  builtAt: "2026-10-01T00:00:00.000Z",
};

/** A fake `ASSETS` binding: a path → body map with the asset layer's quirks. */
function fakeAssets(
  files: Record<string, string>,
  headers: Record<string, string> = {},
): AssetSource {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let path = url.pathname;
      // html_handling "auto-trailing-slash": `/demo` redirects to `/demo/`,
      // `/demo/` serves `demo/index.html`.
      if (path !== "/" && !path.includes(".") && !path.endsWith("/")) {
        if (`${path}/index.html` in files) {
          return new Response(null, {
            status: 307,
            headers: { Location: `${path}/` },
          });
        }
      }
      if (path.endsWith("/")) path = `${path}index.html`;
      const body = files[path];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": path.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : "text/plain",
          "Cache-Control": "public, max-age=0, must-revalidate",
          "Set-Cookie": "leak=1",
          ...headers,
        },
      });
    },
  };
}

const assets = fakeAssets({
  "/v1.js": "console.log('v1')",
  "/v1.js.map": "{}",
  "/v1.0123abcd.js": "console.log('v1')",
  "/v1.0123abcd.js.map": "{}",
  "/version.json": JSON.stringify(MANIFEST),
  "/demo/index.html": "<!doctype html><title>demo</title>",
});

const get = (path: string, init?: RequestInit) =>
  handleRequest(new Request(`${ORIGIN}${path}`, init), assets);

describe("path classification", () => {
  it("recognizes the snippet files, latest and hashed, with their maps", () => {
    for (const p of [
      "/v1.js",
      "/v1.js.map",
      "/v1.0123abcd.js",
      "/v1.0123abcd.js.map",
    ]) {
      expect(isSnippetPath(p), p).toBe(true);
    }
    for (const p of [
      "/version.json",
      "/demo/",
      "/v2.js",
      "/v1.XYZ.js",
      "/v1.0123abc.js",
      "/x/v1.js",
    ]) {
      expect(isSnippetPath(p), p).toBe(false);
    }
  });

  it("treats only the hashed files as immutable", () => {
    expect(isImmutablePath("/v1.0123abcd.js")).toBe(true);
    expect(isImmutablePath("/v1.0123abcd.js.map")).toBe(true);
    expect(isImmutablePath("/v1.js")).toBe(false);
    expect(isImmutablePath("/v1.js.map")).toBe(false);
    expect(cacheControlFor("/v1.0123abcd.js")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cacheControlFor("/v1.js")).toBe(MUTABLE_CACHE_CONTROL);
    expect(cacheControlFor("/demo/")).toBe(MUTABLE_CACHE_CONTROL);
  });
});

describe("withCdnHeaders", () => {
  it("replaces the asset layer's cache policy, strips cookies, adds nosniff", () => {
    const upstream = new Response("x", {
      headers: {
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Set-Cookie": "a=b",
        ETag: '"abc"',
      },
    });
    const res = withCdnHeaders(upstream, "/v1.js");
    expect(res.headers.get("Cache-Control")).toBe(MUTABLE_CACHE_CONTROL);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("ETag")).toBe('"abc"'); // conditional requests keep working
  });

  it("fills in a content type by extension only when upstream left it out", () => {
    // A null body is the one way to build a Response with no Content-Type.
    const bare = withCdnHeaders(new Response(null), "/v1.js.map");
    expect(bare.headers.get("Content-Type")).toBe("application/json");
    const typed = withCdnHeaders(
      new Response("x", { headers: { "Content-Type": "text/custom" } }),
      "/v1.js",
    );
    expect(typed.headers.get("Content-Type")).toBe("text/custom");
  });

  it("marks errors no-store so an edge never caches a 404 for the TTL", () => {
    const res = withCdnHeaders(new Response("nope", { status: 404 }), "/v1.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("GET /v1.js and friends", () => {
  it("serves the latest build with the 5 min + stale-while-revalidate policy and CORS", async () => {
    const res = await get("/v1.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('v1')");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=86400",
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("marks the snippet files, and only them, as embeddable cross-origin (CORP)", async () => {
    for (const path of [
      "/v1.js",
      "/v1.js.map",
      "/v1.0123abcd.js",
      "/v1.0123abcd.js.map",
    ]) {
      const res = await get(path);
      expect(res.headers.get("Cross-Origin-Resource-Policy"), path).toBe(
        "cross-origin",
      );
    }
    // A missing hashed build is still a snippet path: no-store, and the
    // same embeddability so a CORP-strict page gets a clean 404, not a
    // blocked response it cannot see.
    const missing = await get("/v1.ffffffff.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(missing.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "cross-origin",
    );
    for (const path of ["/version.json", "/demo/", "/health"]) {
      const res = await get(path);
      expect(res.headers.get("Cross-Origin-Resource-Policy"), path).toBeNull();
    }
  });

  it("serves the hashed build as immutable for a year", async () => {
    const res = await get("/v1.0123abcd.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("serves both source maps with CORS", async () => {
    for (const [path, policy] of [
      ["/v1.js.map", MUTABLE_CACHE_CONTROL],
      ["/v1.0123abcd.js.map", IMMUTABLE_CACHE_CONTROL],
    ] as const) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Cache-Control"), path).toBe(policy);
      expect(res.headers.get("Access-Control-Allow-Origin"), path).toBe("*");
    }
  });

  it("does not grant CORS outside the snippet files", async () => {
    const res = await get("/version.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe(MUTABLE_CACHE_CONTROL);
  });

  it("answers a preflight for the snippet with no body", async () => {
    const res = await get("/v1.js", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    const other = await get("/demo/", { method: "OPTIONS" });
    expect(other.status).toBe(204);
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects writes", async () => {
    const res = await get("/v1.js", { method: "POST", body: "x" });
    expect(res.status).toBe(405);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("passes a missing asset through as a no-store 404", async () => {
    const res = await get("/v1.ffffffff.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });
});

describe("the demo site", () => {
  it("serves /demo/ from public/demo/index.html", async () => {
    const res = await get("/demo/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>demo</title>");
    expect(res.headers.get("Cache-Control")).toBe(MUTABLE_CACHE_CONTROL);
  });

  it("lets the asset layer's trailing-slash redirect through", async () => {
    const res = await get("/demo");
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("/demo/");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("redirects the root to the demo", async () => {
    const res = await get("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/demo/`);
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
  });
});

describe("GET /health", () => {
  it("reports ok with the deployed build's version and hash, uncached", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: "0.0.0",
      hash: "0123abcd",
    });
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("is a 503 when public/ was never built (no version.json)", async () => {
    const empty = fakeAssets({});
    const res = await handleRequest(new Request(`${ORIGIN}/health`), empty);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("is a 503 on a malformed manifest", async () => {
    const bad = fakeAssets({ "/version.json": '{"version": 1}' });
    const res = await handleRequest(new Request(`${ORIGIN}/health`), bad);
    expect(res.status).toBe(503);
    expect(await readVersion(bad, ORIGIN)).toBeNull();
    const broken = fakeAssets({ "/version.json": "not json" });
    expect(await readVersion(broken, ORIGIN)).toBeNull();
  });

  it("validates the manifest shape", () => {
    expect(isVersionManifest(MANIFEST)).toBe(true);
    expect(isVersionManifest({ ...MANIFEST, hash: 1 })).toBe(false);
    expect(isVersionManifest(null)).toBe(false);
    expect(isVersionManifest("x")).toBe(false);
  });

  it("survives a throwing binding", async () => {
    const throwing: AssetSource = {
      fetch: async () => {
        throw new Error("boom");
      },
    };
    const health = await handleRequest(
      new Request(`${ORIGIN}/health`),
      throwing,
    );
    expect(health.status).toBe(503);
    const file = await handleRequest(new Request(`${ORIGIN}/v1.js`), throwing);
    expect(file.status).toBe(500);
    expect(file.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
