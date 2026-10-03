/**
 * Every Postgres enum takes its values from a `@proofql/core` constant (#61):
 * one source of truth, so a value added in core without a migration — or a
 * new `pgEnum` with a private tuple — fails here before `pnpm db:generate`
 * has to say so.
 */

import {
  API_KEY_ENVIRONMENTS,
  API_KEY_KINDS,
  CHUNK_KINDS,
  CONNECTION_KINDS,
  CONNECTION_STATUSES,
  INGEST_RUN_KINDS,
  INGEST_RUN_STATUSES,
  PLAN_NAMES,
  SENTIMENT_SOURCES,
  SENTIMENTS,
} from "@proofql/core";
import { isPgEnum } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "./index.js";

/** Enum name, the drizzle enum, and the core constant it must mirror. */
type Mirror = [
  name: string,
  pg: { enumName: string; enumValues: readonly string[] },
  core: readonly string[],
];

const mirrors: readonly Mirror[] = [
  ["account_plan", schema.accountPlanEnum, PLAN_NAMES],
  ["api_key_kind", schema.apiKeyKindEnum, API_KEY_KINDS],
  ["chunk_kind", schema.chunkKindEnum, CHUNK_KINDS],
  ["connection_kind", schema.connectionKindEnum, CONNECTION_KINDS],
  ["connection_status", schema.connectionStatusEnum, CONNECTION_STATUSES],
  ["environment", schema.environmentEnum, API_KEY_ENVIRONMENTS],
  ["ingest_run_kind", schema.ingestRunKindEnum, INGEST_RUN_KINDS],
  ["ingest_run_status", schema.ingestRunStatusEnum, INGEST_RUN_STATUSES],
  ["sentiment", schema.sentimentEnum, SENTIMENTS],
  ["sentiment_source", schema.sentimentSourceEnum, SENTIMENT_SOURCES],
];

describe("pg enums mirror @proofql/core", () => {
  it.each(mirrors)("%s", (name, pg, core) => {
    expect(pg.enumName).toBe(name);
    expect(pg.enumValues).toEqual([...core]);
  });

  it("covers every enum the schema barrel exports", () => {
    const exported = (Object.values(schema) as unknown[]).filter(isPgEnum);
    expect(exported.map((e) => e.enumName).sort()).toEqual(
      mirrors.map(([name]) => name).sort(),
    );
  });
});
