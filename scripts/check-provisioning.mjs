#!/usr/bin/env node
/**
 * Report which Cloudflare resources in the wrangler configs are still the
 * `TBD-provision-in-m0` placeholder, per environment and per worker.
 *
 *     node scripts/check-provisioning.mjs            # report preview + prod
 *     node scripts/check-provisioning.mjs preview    # one env; exit 1 if any remain
 *     node scripts/check-provisioning.mjs prod
 *
 * Read-only: it parses every worker's wrangler.jsonc and prints. It touches
 * no network and no Cloudflare API. The deploy workflow runs it before
 * `wrangler deploy` so an unprovisioned environment fails with a readable
 * list instead of wrangler's generic "KV namespace not found".
 *
 * Only `env.preview` and `env.prod` are inspected: the top-level (local)
 * block is served by Miniflare simulators that ignore ids, so its
 * placeholders are permanent and fine (infra/environments.md).
 *
 * No dependencies on purpose (the deploy workflow runs it right after
 * checkout, and it must stay trivially runnable from a fresh clone).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLACEHOLDER = "TBD-provision-in-m0";
export const ENVS = ["preview", "prod"];

/** Workspace directory → human name; order is the deploy order. */
export const WORKERS = [
  ["workers/pipeline", "pipeline"],
  ["workers/api", "api"],
  // Static assets only; nothing to provision. Listed so its env blocks are
  // checked and the report mirrors the deploy order.
  ["workers/cdn", "cdn"],
  ["apps/dashboard", "dashboard"],
];

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Strip `//` and `/* *\/` comments and trailing commas from JSONC without
 * touching string contents (URLs such as `http://localhost:8797` live in
 * string values and must survive).
 */
export function stripJsonc(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') {
      // Copy the whole string literal, honoring escapes.
      let j = i + 1;
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\") j += 1;
        j += 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  // Trailing commas before a closing bracket/brace are legal JSONC.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Walk a value and return the dotted paths of every string equal to the
 * placeholder, e.g. `kv_namespaces[0].id` or `vars.API_URL`.
 */
export function findPlaceholders(value, path = "") {
  if (typeof value === "string") return value === PLACEHOLDER ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findPlaceholders(item, `${path}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      findPlaceholders(child, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

/**
 * Translate a config path into the resource the owner has to create, so the
 * report reads like the provisioning checklist (infra/provisioning.md).
 */
export function describe(path, env) {
  if (path.startsWith("kv_namespaces")) {
    return `KV namespace id (proofql-cache-${env})`;
  }
  if (path.startsWith("hyperdrive")) {
    return `Hyperdrive config id (proofql-hyperdrive-${env})`;
  }
  if (path.startsWith("vars.API_URL")) {
    return `api worker public origin (proofql-api-${env} URL)`;
  }
  return "unprovisioned value";
}

/** @returns {{ env: string, worker: string, path: string, what: string }[]} */
export function collect(envs = ENVS, root = ROOT) {
  const findings = [];
  for (const [dir, worker] of WORKERS) {
    const file = resolve(root, dir, "wrangler.jsonc");
    const config = JSON.parse(stripJsonc(readFileSync(file, "utf8")));
    for (const env of envs) {
      const block = config.env?.[env];
      if (!block) {
        findings.push({
          env,
          worker,
          path: `env.${env}`,
          what: "missing env block",
        });
        continue;
      }
      for (const path of findPlaceholders(block)) {
        findings.push({ env, worker, path, what: describe(path, env) });
      }
    }
  }
  return findings;
}

function usage() {
  console.error(
    `usage: node scripts/check-provisioning.mjs [${ENVS.join("|")}]`,
  );
  process.exit(2);
}

function main(argv) {
  const [arg, ...rest] = argv;
  if (rest.length > 0 || (arg !== undefined && !ENVS.includes(arg))) usage();
  const envs = arg ? [arg] : ENVS;
  const findings = collect(envs);

  for (const env of envs) {
    const rows = findings.filter((f) => f.env === env);
    const state = rows.length === 0 ? "provisioned" : "UNPROVISIONED";
    console.log(`\n${env}: ${state}`);
    for (const [, worker] of WORKERS) {
      const own = rows.filter((f) => f.worker === worker);
      if (own.length === 0) {
        console.log(`  ${worker.padEnd(10)} ok`);
        continue;
      }
      for (const f of own) {
        console.log(`  ${worker.padEnd(10)} ${f.path.padEnd(22)} ${f.what}`);
      }
    }
  }

  if (findings.length > 0) {
    console.log(
      `\n${findings.length} placeholder(s) remain (${PLACEHOLDER}). ` +
        "Follow infra/provisioning.md and paste the real ids into the " +
        "wrangler.jsonc env blocks.",
    );
    process.exit(1);
  }
  console.log("\nAll bindings provisioned.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
