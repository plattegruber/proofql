// Test-only: read a committed fixture from packages/core/test/fixtures/csv.
import { readFileSync } from "node:fs";

export function fixture(name: string): string {
  return readFileSync(
    new URL(`./fixtures/csv/${name}`, import.meta.url),
    "utf8",
  );
}

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./fixtures/csv/${name}`, import.meta.url)),
  );
}
