// The dashboard's response headers (#49): the CSP's moving parts (Clerk's
// host from the key, the api and snippet origins, local relaxations), the
// route-owned-CSP rule for the onboarding preview, and HSTS by environment.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  applySecurityHeaders,
  clerkFrontendApi,
  contentSecurityPolicy,
  HSTS_VALUE,
  originOf,
  securityHeadersFor,
} from "./security-headers";

/** `pk_test_<base64("host$")>`, the real key format. */
function fakeKey(host: string, kind: "test" | "live" = "test"): string {
  return `pk_${kind}_${btoa(`${host}$`)}`;
}

const prodEnv = {
  ENVIRONMENT: "prod",
  API_URL: "https://api.proofql.dev",
  SNIPPET_SRC: "https://cdn.proofql.dev/v1.js",
  CLERK_PUBLISHABLE_KEY: fakeKey("clerk.proofql.dev", "live"),
};

function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
}

describe("clerkFrontendApi", () => {
  it("decodes the Frontend API host out of a publishable key", () => {
    expect(clerkFrontendApi(fakeKey("foo-bar-12.clerk.accounts.dev"))).toBe(
      "https://foo-bar-12.clerk.accounts.dev",
    );
    expect(clerkFrontendApi(fakeKey("clerk.proofql.dev", "live"))).toBe(
      "https://clerk.proofql.dev",
    );
  });

  it("is null for the local stub (no key), placeholders and garbage", () => {
    expect(clerkFrontendApi(undefined)).toBeNull();
    expect(clerkFrontendApi("")).toBeNull();
    expect(clerkFrontendApi("TBD-provision-in-m0")).toBeNull();
    expect(clerkFrontendApi("pk_test_!!!")).toBeNull();
    expect(clerkFrontendApi(`pk_test_${btoa("not a host$")}`)).toBeNull();
    expect(
      clerkFrontendApi(`pk_test_${btoa("javascript:alert(1)$")}`),
    ).toBeNull();
  });
});

/**
 * `env.prod.vars` of the real apps/dashboard/wrangler.jsonc. The file's
 * comments are whole lines, so dropping those and trailing commas is enough
 * to make it JSON.
 */
function deployedProdVars(): Record<string, string> {
  const source = readFileSync(
    new URL("../../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const json = source
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(json).env.prod.vars;
}

describe("the deployed prod config (apps/dashboard/wrangler.jsonc)", () => {
  const vars = deployedProdVars();

  it("carries the Clerk production key, whose Frontend API is clerk.proofql.dev", () => {
    expect(vars.CLERK_PUBLISHABLE_KEY).toMatch(/^pk_live_/);
    expect(clerkFrontendApi(vars.CLERK_PUBLISHABLE_KEY)).toBe(
      "https://clerk.proofql.dev",
    );
    expect(vars.API_URL).toBe("https://api.proofql.dev");
    expect(vars.SNIPPET_SRC).toBe("https://cdn.proofql.dev/v1.js");
  });

  it("yields a CSP that allows Clerk's FAPI, the snippet origin and the api", () => {
    const csp = contentSecurityPolicy({ ...vars, ENVIRONMENT: "prod" });
    for (const name of ["script-src", "connect-src"]) {
      expect(directive(csp, name)).toContain("https://clerk.proofql.dev");
      expect(directive(csp, name)).toContain("https://cdn.proofql.dev");
    }
    expect(directive(csp, "frame-src")).toContain("https://clerk.proofql.dev");
    expect(directive(csp, "connect-src")).toContain("https://api.proofql.dev");
  });
});

describe("originOf", () => {
  it("reduces a URL to its origin and refuses non-URLs", () => {
    expect(originOf("https://cdn.proofql.dev/v1.js")).toBe(
      "https://cdn.proofql.dev",
    );
    expect(originOf("http://localhost:8800/v1.js")).toBe(
      "http://localhost:8800",
    );
    expect(originOf("TBD-provision-in-m0")).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
  });
});

describe("contentSecurityPolicy", () => {
  it("allows Clerk, Turnstile and the snippet origin to run scripts, and nothing else", () => {
    const csp = contentSecurityPolicy(prodEnv);
    expect(directive(csp, "script-src")).toBe(
      "script-src 'self' 'unsafe-inline' https://clerk.proofql.dev https://challenges.cloudflare.com https://cdn.proofql.dev",
    );
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
  });

  it("lets the browser reach Clerk and the api, and frame the preview page and Turnstile", () => {
    const csp = contentSecurityPolicy(prodEnv);
    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' https://clerk.proofql.dev https://clerk-telemetry.com https://api.proofql.dev https://cdn.proofql.dev",
    );
    expect(directive(csp, "frame-src")).toBe(
      "frame-src 'self' https://challenges.cloudflare.com https://clerk.proofql.dev",
    );
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "upgrade-insecure-requests")).toBe(
      "upgrade-insecure-requests",
    );
  });

  it("omits Clerk when the key is absent or a placeholder (local stub, unprovisioned preview)", () => {
    const csp = contentSecurityPolicy({
      ...prodEnv,
      CLERK_PUBLISHABLE_KEY: "TBD-provision-in-m0",
    });
    expect(directive(csp, "script-src")).not.toContain("clerk");
    expect(directive(csp, "connect-src")).toContain("https://api.proofql.dev");
  });

  it("relaxes connect-src for the Vite dev server locally and drops upgrade-insecure-requests", () => {
    const csp = contentSecurityPolicy({
      ENVIRONMENT: "local",
      API_URL: "http://localhost:8797",
      SNIPPET_SRC: "http://localhost:8800/v1.js",
      CLERK_PUBLISHABLE_KEY: "",
    });
    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' https://clerk-telemetry.com http://localhost:8797 http://localhost:8800 ws://localhost:* http://localhost:*",
    );
    expect(directive(csp, "script-src")).toContain("http://localhost:8800");
    expect(directive(csp, "upgrade-insecure-requests")).toBeUndefined();
  });
});

describe("securityHeadersFor", () => {
  it("sets the frame, sniff, referrer and permissions headers everywhere", () => {
    const headers = securityHeadersFor({ ENVIRONMENT: "local" });
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("asserts HSTS in preview and prod only", () => {
    expect(
      securityHeadersFor({ ENVIRONMENT: "local" })["Strict-Transport-Security"],
    ).toBeUndefined();
    expect(securityHeadersFor({})["Strict-Transport-Security"]).toBeUndefined();
    for (const ENVIRONMENT of ["preview", "prod"]) {
      expect(
        securityHeadersFor({ ENVIRONMENT })["Strict-Transport-Security"],
      ).toBe(HSTS_VALUE);
    }
  });
});

describe("applySecurityHeaders", () => {
  it("adds every header to a plain response", () => {
    const headers = new Headers({ "Content-Type": "text/html" });
    applySecurityHeaders(headers, prodEnv);
    expect(headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Strict-Transport-Security")).toBe(HSTS_VALUE);
  });

  it("leaves a route-owned CSP alone and adds no X-Frame-Options beside it (the onboarding preview)", () => {
    // What app/routes/app.onboarding.$slug.preview.ts sets.
    const headers = new Headers({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
    });
    applySecurityHeaders(headers, prodEnv);
    expect(headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'self'",
    );
    expect(headers.get("X-Frame-Options")).toBeNull();
    // The rest still arrives.
    expect(headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headers.get("Strict-Transport-Security")).toBe(HSTS_VALUE);
  });

  it("never overrides a header a route set itself", () => {
    const headers = new Headers({ "Referrer-Policy": "no-referrer" });
    applySecurityHeaders(headers, prodEnv);
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});
