// The browser-side reader against real zip archives built from the
// fabricated Takeout fixture (packages/core/test/fixtures/takeout), plus a
// fake photo that must never be inflated. Node 22's File and streams stand
// in for the browser's.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { readTakeoutSelection, TakeoutReadError } from "./takeout-reader";

const ROOT = new URL(
  "../../../../packages/core/test/fixtures/takeout/",
  import.meta.url,
).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function fixtureEntries(): Record<string, Uint8Array<ArrayBuffer>> {
  const entries: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const path of walk(ROOT)) {
    entries[relative(ROOT, path)] = new Uint8Array(readFileSync(path));
  }
  return entries;
}

function zipFile(name: string, entries: Record<string, Uint8Array>): File {
  return new File([zipSync(entries, { level: 6 })], name, {
    type: "application/zip",
  });
}

describe("readTakeoutSelection", () => {
  it("reads a whole export: locations, titles, star-only counts, repeats merged", async () => {
    const photo = new Uint8Array(256 * 1024).fill(7);
    const archive = zipFile("takeout-20261008T000000Z-001.zip", {
      ...fixtureEntries(),
      "Takeout/Google Business Profile/account-1009/location-2001/photo-1.jpg":
        photo,
      "Takeout/archive_browser.html": strToU8("<html></html>"),
    });
    const progress: number[] = [];
    const result = await readTakeoutSelection([archive], (p) =>
      progress.push(p.bytesRead),
    );
    expect(result.fromArchives).toBe(true);
    expect(result.archives).toBe(1);
    expect(result.mapsReviews).toBe(true);
    expect(result.duplicates).toBe(2);
    expect(
      result.locations.map((l) => [l.title, l.reviews.length, l.starOnly]),
    ).toEqual([
      ["Harbor Light Bakery", 23, 2],
      ["Harbor Light Bakery — Pearl Street", 4, 0],
    ]);
    expect(progress.at(-1)).toBe(archive.size);
  });

  it("merges a split export across parts", async () => {
    const entries = Object.entries(fixtureEntries());
    const half = Math.ceil(entries.length / 2);
    const result = await readTakeoutSelection([
      zipFile("takeout-001.zip", Object.fromEntries(entries.slice(0, half))),
      zipFile("takeout-002.zip", Object.fromEntries(entries.slice(half))),
    ]);
    expect(result.archives).toBe(2);
    expect(result.locations.map((l) => l.reviews.length)).toEqual([23, 4]);
  });

  it("reads loose reviews.json files, which never count as complete", async () => {
    const entries = fixtureEntries();
    const page = Object.keys(entries).find((p) =>
      p.endsWith("location-2002/reviews.json"),
    ) as string;
    const result = await readTakeoutSelection([
      new File([entries[page] as Uint8Array<ArrayBuffer>], "reviews.json"),
    ]);
    expect(result.fromArchives).toBe(false);
    expect(result.looseFiles).toBe(1);
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0]?.title).toBeNull();
  });

  it("explains Maps' Reviews.json, a .tgz, an empty archive and a broken zip", async () => {
    const maps = fixtureEntries()["Takeout/Maps (your places)/Reviews.json"];
    await expect(
      readTakeoutSelection([
        new File([maps as Uint8Array<ArrayBuffer>], "Reviews.json"),
      ]),
    ).rejects.toThrow("reviews you wrote about other places");
    await expect(
      readTakeoutSelection([new File(["x"], "takeout-001.tgz")]),
    ).rejects.toThrow('"File type: .zip"');
    await expect(
      readTakeoutSelection([
        zipFile("takeout.zip", { "Takeout/Drive/notes.txt": strToU8("hi") }),
      ]),
    ).rejects.toThrow("Check that Google Business Profile was selected");
    await expect(
      readTakeoutSelection([new File(["not a zip at all"], "takeout.zip")]),
    ).rejects.toBeInstanceOf(TakeoutReadError);
    await expect(
      readTakeoutSelection([new File(["a,b"], "reviews.csv")]),
    ).rejects.toThrow("not a .zip or a .json file");
  });
});
