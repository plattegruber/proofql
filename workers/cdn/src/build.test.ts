import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildCdn,
  contentHash,
  isBuildOutput,
  retargetSourceMap,
} from "../scripts/build.mjs";

describe("build helpers", () => {
  it("hashes to 8 hex characters of sha256", () => {
    expect(contentHash("hello")).toBe("2cf24dba");
    expect(contentHash(Buffer.from("hello"))).toBe("2cf24dba");
    expect(contentHash("hello!")).not.toBe("2cf24dba");
  });

  it("retargets only the sourceMappingURL comment", () => {
    const src =
      'var a="//# sourceMappingURL=keep.js.map";\n//# sourceMappingURL=v1.js.map\n';
    expect(retargetSourceMap(src, "v1.abcdef01.js.map")).toBe(
      'var a="//# sourceMappingURL=keep.js.map";\n//# sourceMappingURL=v1.abcdef01.js.map\n',
    );
  });

  it("knows which files a build owns, and leaves everything else alone", () => {
    for (const f of [
      "v1.js",
      "v1.js.map",
      "v1.0123abcd.js",
      "v1.0123abcd.js.map",
      "version.json",
    ]) {
      expect(isBuildOutput(f), f).toBe(true);
    }
    for (const f of [
      "demo",
      "index.html",
      "v2.js",
      "v1.min.js",
      "robots.txt",
    ]) {
      expect(isBuildOutput(f), f).toBe(false);
    }
  });
});

describe("buildCdn", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tmp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "proofql-cdn-"));
    dirs.push(dir);
    return dir;
  }

  it("writes the snippet, its hashed twin, both maps and version.json", async () => {
    const outDir = await tmp();
    const now = new Date("2026-10-01T12:00:00.000Z");
    const result = await buildCdn({ outDir, now });

    const hashed = `v1.${result.hash}.js`;
    expect(result.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(result.files).toEqual(
      ["v1.js", "v1.js.map", hashed, `${hashed}.map`, "version.json"].sort(),
    );
    expect((await readdir(outDir)).sort()).toEqual(result.files);

    const latest = await readFile(join(outDir, "v1.js"), "utf8");
    const twin = await readFile(join(outDir, hashed), "utf8");
    expect(contentHash(latest)).toBe(result.hash);
    expect(latest).toContain("//# sourceMappingURL=v1.js.map");
    expect(twin).toContain(`//# sourceMappingURL=${hashed}.map`);
    // Same code, only the map comment differs.
    expect(retargetSourceMap(latest, `${hashed}.map`)).toBe(twin);
    // It is the real bundle: the IIFE exposes window.ProofQL.
    expect(latest).toContain("ProofQL");

    const map = JSON.parse(await readFile(join(outDir, "v1.js.map"), "utf8"));
    expect(map.version).toBe(3);
    expect(await readFile(join(outDir, `${hashed}.map`), "utf8")).toBe(
      await readFile(join(outDir, "v1.js.map"), "utf8"),
    );

    const manifest = JSON.parse(
      await readFile(join(outDir, "version.json"), "utf8"),
    );
    expect(manifest).toEqual({
      version: result.version,
      hash: result.hash,
      builtAt: "2026-10-01T12:00:00.000Z",
    });
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is deterministic and removes stale hashed copies but not the demo", async () => {
    const outDir = await tmp();
    await writeFile(join(outDir, "v1.deadbeef.js"), "stale");
    await writeFile(join(outDir, "v1.deadbeef.js.map"), "stale");
    await writeFile(join(outDir, "robots.txt"), "keep");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(outDir, "demo"));
    await writeFile(join(outDir, "demo", "index.html"), "<title>keep</title>");

    const first = await buildCdn({ outDir });
    const second = await buildCdn({ outDir });
    expect(second.hash).toBe(first.hash);

    const names = (await readdir(outDir)).sort();
    expect(names).not.toContain("v1.deadbeef.js");
    expect(names).not.toContain("v1.deadbeef.js.map");
    expect(names).toContain("robots.txt");
    expect(names).toContain("demo");
    expect(await readFile(join(outDir, "demo", "index.html"), "utf8")).toBe(
      "<title>keep</title>",
    );
  });
});
