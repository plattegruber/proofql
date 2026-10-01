// Types for scripts/build.mjs, for the Vitest build test (src/build.test.ts).
export const PUBLIC_DIR: string;
export function contentHash(bytes: Uint8Array | string): string;
export function retargetSourceMap(source: string, mapName: string): string;
export function isBuildOutput(name: string): boolean;
export function buildCdn(options?: { outDir?: string; now?: Date }): Promise<{
  outDir: string;
  hash: string;
  version: string;
  files: string[];
}>;
