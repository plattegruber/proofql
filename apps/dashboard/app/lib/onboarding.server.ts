/**
 * Server side of the guided onboarding (#53).
 *
 * - **One action creates the project and both live keys** —
 *   `startOnboardingProject` wraps `createProject` and two `createApiKey`
 *   calls in one transaction, so a user never ends up with a project and
 *   no keys. Only hashes are stored (api-keys.server.ts); the plaintexts
 *   go into the onboarding cookie below so step 4 can show them once.
 * - **The onboarding cookie** (`__pq_onboarding`) is a signed cookie
 *   session (same storage and secret as the flash, app/lib/flash.server.ts)
 *   that lives for ONBOARDING_COOKIE_MAX_AGE_S = one hour. It carries
 *   `startedAt` (for the five-minute measurement), the project id, and the
 *   two plaintexts. The dashboard never persists a plaintext anywhere else:
 *   when the cookie has expired, step 4 shows the tag with a placeholder key
 *   and points at the Keys tab. Finishing or dismissing clears it.
 * - **Completion** is `accounts.onboarding_completed_at` (migration 0005),
 *   set on finish and on "I'll do this later", so the overview redirect
 *   stops across devices.
 */
import type { Logger } from "@proofql/core";
import { type Db, schema } from "@proofql/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  createCookieSessionStorage,
  data,
  type HeadersArgs,
  type Session,
} from "react-router";

import { type RequireAccountArgs, requireAccount } from "./account.server";
import { findProjectBySlug, type Project } from "./accounts";
import { type CreatedApiKey, createApiKey } from "./api-keys.server";
import { getCloudflare } from "./context";
import { withRequestDb } from "./db.server";
import type { FlashEnv } from "./flash.server";
import {
  type IndexingCounts,
  type OnboardingStep,
  suggestQueryFromTexts,
} from "./onboarding";
import {
  type CreateProjectResult,
  createProject,
  setAllowedOrigins,
} from "./projects.server";

// --- The onboarding cookie ---------------------------------------------------

export const ONBOARDING_COOKIE_NAME = "__pq_onboarding";
/** One hour: long enough for the slowest walkthrough, short for a secret. */
export const ONBOARDING_COOKIE_MAX_AGE_S = 60 * 60;

export interface OnboardingSessionData {
  /** ISO time step 1 was first shown; the five-minute clock starts here. */
  startedAt?: string;
  projectId?: string;
  /** Plaintexts of the keys minted in step 1 — shown once in step 4. */
  publishable?: string;
  secret?: string;
}

export type OnboardingSession = Session<OnboardingSessionData>;

function storage(env: FlashEnv) {
  const configured = env.SESSION_SECRET?.trim() || undefined;
  if (configured === undefined && env.ENVIRONMENT !== "local") {
    throw new Error("SESSION_SECRET is not set");
  }
  return createCookieSessionStorage<OnboardingSessionData>({
    cookie: {
      name: ONBOARDING_COOKIE_NAME,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: ONBOARDING_COOKIE_MAX_AGE_S,
      secrets: [configured ?? "dev-only-insecure-secret"],
      secure: env.ENVIRONMENT !== "local",
    },
  });
}

export async function readOnboardingSession(
  env: FlashEnv,
  request: Request,
): Promise<OnboardingSession> {
  return storage(env).getSession(request.headers.get("Cookie"));
}

/** `Set-Cookie` headers that persist the session for another hour. */
export async function commitOnboardingSession(
  env: FlashEnv,
  session: OnboardingSession,
): Promise<Headers> {
  return new Headers({
    "Set-Cookie": await storage(env).commitSession(session),
  });
}

/** `Set-Cookie` headers that delete the cookie. */
export async function clearOnboardingSession(
  env: FlashEnv,
  session: OnboardingSession,
): Promise<Headers> {
  return new Headers({
    "Set-Cookie": await storage(env).destroySession(session),
  });
}

/** The plaintexts for `projectId`, or nulls when the cookie is for another project or gone. */
export function sessionKeysFor(
  session: OnboardingSession,
  projectId: string,
): { publishable: string | null; secret: string | null } {
  if (session.get("projectId") !== projectId) {
    return { publishable: null, secret: null };
  }
  return {
    publishable: session.get("publishable") ?? null,
    secret: session.get("secret") ?? null,
  };
}

// --- Timing ------------------------------------------------------------------

/** Milliseconds since `startedAt`; null when the clock never started. */
export function elapsedSince(
  startedAt: string | undefined,
  now: Date = new Date(),
): number | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return Math.max(0, now.getTime() - started);
}

/** `onboarding.step` — one line per step shown (docs/observability.md). */
export function logOnboardingStep(
  log: Logger,
  step: OnboardingStep,
  fields: {
    elapsed_ms: number | null;
    account_id: string;
    project_id?: string;
  },
): void {
  log.log("onboarding.step", { step, ...fields });
}

// --- Step 1: project + keys --------------------------------------------------

export type StartOnboardingResult =
  | {
      ok: true;
      project: Project;
      publishable: CreatedApiKey;
      secret: CreatedApiKey;
    }
  | Extract<CreateProjectResult, { ok: false }>;

/**
 * Create the project, allow `origin` (the dashboard's own origin, so the
 * step-4 preview can query from it; the user can remove it in Keys), and
 * mint a live publishable and a live secret key — all or nothing.
 */
export async function startOnboardingProject(
  db: Db,
  input: {
    account: { id: string; plan: string };
    name: string;
    slug: string;
    /** Added to `allowed_origins` for the preview; omit to add none. */
    origin?: string;
  },
): Promise<StartOnboardingResult> {
  return db.transaction(async (tx) => {
    const created = await createProject(tx, {
      account: input.account,
      name: input.name,
      slug: input.slug,
    });
    if (!created.ok) return created;
    let project = created.project;
    if (input.origin) {
      const updated = await setAllowedOrigins(
        tx,
        { projectId: project.id, accountId: input.account.id },
        [input.origin],
      );
      if (updated) project = updated;
    }
    const publishable = await createApiKey(tx, {
      projectId: project.id,
      kind: "publishable",
      environment: "live",
    });
    const secret = await createApiKey(tx, {
      projectId: project.id,
      kind: "secret",
      environment: "live",
    });
    return { ok: true, project, publishable, secret };
  });
}

// --- Step 3: indexing counts -------------------------------------------------

/** Live reviews vs. how many of them the pipeline has indexed. */
export async function projectIndexing(
  db: Db,
  projectId: string,
): Promise<IndexingCounts> {
  const scope = and(
    eq(schema.reviews.projectId, projectId),
    eq(schema.reviews.environment, "live"),
  );
  const [indexedRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.reviews)
    .where(and(scope, isNotNull(schema.reviews.indexedAt)));
  const [indexingRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.reviews)
    .where(and(scope, isNull(schema.reviews.indexedAt)));
  const indexed = indexedRow?.n ?? 0;
  const indexing = indexingRow?.n ?? 0;
  return { reviews: indexed + indexing, indexed, indexing };
}

// --- Step 4: the suggested query ---------------------------------------------

/** How many `full` chunks the suggestion reads; plenty for a frequency count. */
export const SUGGESTION_SAMPLE_CHUNKS = 500;

/**
 * The most common content words across the project's indexed live reviews,
 * as a two-word query (`suggestQueryFromTexts`). Reads the `full` chunks —
 * one per review, so long reviews do not count twice through their windows.
 */
export async function suggestQuery(
  db: Db,
  projectId: string,
): Promise<string | null> {
  const rows = await db
    .select({ text: schema.reviewChunks.text })
    .from(schema.reviewChunks)
    .where(
      and(
        eq(schema.reviewChunks.projectId, projectId),
        eq(schema.reviewChunks.environment, "live"),
        eq(schema.reviewChunks.kind, "full"),
      ),
    )
    .limit(SUGGESTION_SAMPLE_CHUNKS);
  return suggestQueryFromTexts(rows.map((r) => r.text));
}

// --- Completion --------------------------------------------------------------

/** Set `onboarding_completed_at` once; a second call leaves the first time. */
export async function markOnboardingCompleted(
  db: Db,
  accountId: string,
): Promise<void> {
  await db
    .update(schema.accounts)
    .set({ onboardingCompletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.accounts.id, accountId),
        isNull(schema.accounts.onboardingCompletedAt),
      ),
    );
}

// --- Route plumbing ----------------------------------------------------------

/**
 * What every step-2+ loader and action starts with: the account, the
 * project by slug (404 otherwise), the Workers env and logger, and the
 * onboarding cookie session with the elapsed time since step 1.
 */
export async function requireOnboardingProject(
  args: RequireAccountArgs & { params: { slug: string } },
) {
  const { account } = await requireAccount(args);
  const { env, log } = getCloudflare(args.context);
  const project = await withRequestDb(args.context, (db) =>
    findProjectBySlug(db, account.id, args.params.slug),
  );
  if (!project) throw data(null, { status: 404 });
  const session = await readOnboardingSession(env, args.request);
  return {
    account,
    project,
    env,
    log,
    session,
    elapsed: elapsedSince(session.get("startedAt")),
  };
}

/** Every `Set-Cookie` (and other header) from all sources, in order. */
export function mergeHeaders(...sources: (Headers | undefined)[]): Headers {
  const merged = new Headers();
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of source) merged.append(key, value);
  }
  return merged;
}

/**
 * The `headers` export for onboarding routes: they set cookies of their
 * own, so they must forward the layout's flash-clearing `Set-Cookie`
 * (`parentHeaders`) too — React Router uses the deepest `headers` export
 * only.
 */
export function onboardingRouteHeaders({
  loaderHeaders,
  actionHeaders,
  parentHeaders,
}: HeadersArgs): Headers {
  return mergeHeaders(parentHeaders, loaderHeaders, actionHeaders);
}
