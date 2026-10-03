// The upload allowlist is pure and must be exact (#49): the extension
// decides; the browser's declared type only breaks a tie for a file with no
// extension, and never promotes a disguised one.
import { describe, expect, it } from "vitest";

import { MAX_UPLOAD_BYTES, uploadKind } from "./csv.server";

describe("uploadKind", () => {
  it("accepts the allowlisted extensions, case-insensitively", () => {
    expect(uploadKind("reviews.csv", "text/csv")).toBe("csv");
    expect(uploadKind("REVIEWS.CSV", "application/octet-stream")).toBe("csv");
    expect(uploadKind("export.tsv", "")).toBe("csv");
    expect(uploadKind("export.txt", "")).toBe("csv");
    expect(uploadKind("Reviews.json", "application/octet-stream")).toBe("json");
  });

  it("falls back to the declared type only when there is no extension", () => {
    expect(uploadKind("export", "text/csv")).toBe("csv");
    expect(uploadKind("export", "application/json")).toBe("json");
    expect(uploadKind("export", "application/octet-stream")).toBeNull();
    expect(uploadKind(".hidden", "text/csv")).toBe("csv");
  });

  it("refuses a disguised file whatever the browser says it is", () => {
    expect(uploadKind("payload.exe", "text/csv")).toBeNull();
    expect(uploadKind("evil.html", "application/json")).toBeNull();
    expect(uploadKind("archive.zip", "text/plain")).toBeNull();
    expect(uploadKind("sheet.xlsx", "application/vnd.ms-excel")).toBeNull();
    expect(uploadKind("script.js", "text/csv; charset=utf-8")).toBeNull();
    // A second extension does not help: the last one is what the file is.
    expect(uploadKind("reviews.csv.exe", "text/csv")).toBeNull();
  });

  it("documents the server-side size cap the route and createUpload enforce", () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});
