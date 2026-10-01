import { defineConfig } from "drizzle-kit";

// drizzle-kit is a Node-only dev/CI tool. It must never be imported by Worker
// code — it stays in devDependencies so it is never bundled.
//
// `schema` points at the barrel, not a glob: the barrel is what the typed
// client sees, so it is the single authority on which tables exist, and a
// glob would also sweep up `*.test.ts` files, which drizzle-kit cannot load.
//
// `db:generate` needs no database. `db:migrate` is scripts/migrate.ts (the
// drizzle-orm migrator), not `drizzle-kit migrate`, so the same code path
// runs in CI, in the test harness, and against Neon; `dbCredentials` here
// only serves `drizzle-kit studio`/`check`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
