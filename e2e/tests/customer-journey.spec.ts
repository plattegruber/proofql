/**
 * The customer journey, end to end, against a deployed environment:
 *
 *   account → workspace → project → keys → ingest → indexed → query →
 *   snippet on a real page → Google Takeout import → cleanup
 *
 * One serial test with named steps, so a failure says which stage broke
 * ("7. indexing") and later stages, which depend on it, do not run. The
 * cleanup steps always run. Budget per run (Workers free plan,
 * docs/launch.md §16): 6 reviews, a few dozen requests.
 */
import { clerk } from "@clerk/testing/playwright";
import { expect, type Page, test } from "@playwright/test";

import { ingest, listReviews, query, type StoredReview } from "../lib/api";
import { deleteTestUserByEmail } from "../lib/clerk-admin";
import {
  addAllowedOrigin,
  createKey,
  createProjectViaOnboarding,
  dashboardUrl,
  deleteProject,
  ensureWorkspace,
  listProjectSlugs,
  signIn,
  signUp,
} from "../lib/dashboard";
import {
  acceptanceReviews,
  TARGET_INDEX,
  TARGET_MARKER,
  TARGET_QUERY,
} from "../lib/reviews";
import {
  previewEmail,
  prodEmail,
  runId,
  TEST_PAGE_ORIGIN,
  target,
} from "../lib/target";

/** Ingest → every review `indexed`, as the dashboard reports it. */
const INDEXING_TIMEOUT_MS = 3 * 60 * 1000;

test("customer journey: sign up, set up a project, ingest, query, embed", async ({
  page,
}) => {
  let email: string | undefined;
  let slug: string | undefined;
  let secretKey = "";
  let publishableKey = "";
  let stored: StoredReview[] = [];
  let cleanupError: unknown;
  // The step in progress, for the failure description.
  let currentStep = "";
  const step = (name: string, fn: () => Promise<void>) => {
    currentStep = name;
    return test.step(name, fn);
  };
  const reviews = acceptanceReviews(runId);

  try {
    await step(
      target.auth === "sign-up"
        ? "1. sign up a new user at /sign-up"
        : "1. sign in the acceptance user",
      async () => {
        // Known before the attempt, so a half-finished sign-up is cleaned up.
        email = target.auth === "sign-up" ? previewEmail() : prodEmail();
        if (target.auth === "sign-up") await signUp(page);
        else await signIn(page);
      },
    );

    await step("2. workspace (create or pick at /app/workspace)", async () => {
      await page.goto(dashboardUrl("/app"));
      await ensureWorkspace(page);
      await expect(page).toHaveURL(/\/app(\/|$)/);
      await expect(page).not.toHaveURL(/\/app\/workspace/);
    });

    await step("3. delete projects left by earlier runs", async () => {
      // The free plan allows one project; a previous run that died before
      // its cleanup would otherwise block this one.
      for (const leftover of await listProjectSlugs(page)) {
        await deleteProject(page, leftover);
      }
      expect(await listProjectSlugs(page)).toEqual([]);
    });

    await step("4. create a project (onboarding step 1)", async () => {
      slug = await createProjectViaOnboarding(page, `AT ${runId}`);
    });
    const projectSlug = slug as string;

    await step(
      "5. create keys and allow the test origin (Keys tab)",
      async () => {
        secretKey = await createKey(page, projectSlug, "secret");
        publishableKey = await createKey(page, projectSlug, "publishable");
        await addAllowedOrigin(page, projectSlug, TEST_PAGE_ORIGIN);
      },
    );

    await step("6. push 5 reviews (POST /v1/reviews)", async () => {
      stored = await ingest(secretKey, reviews);
      expect(stored.map((r) => r.external_id)).toEqual(
        reviews.map((r) => r.external_id),
      );
      for (const r of stored)
        expect(["indexing", "indexed"]).toContain(r.status);
    });

    await step(
      "7. dashboard shows the reviews and finishes indexing",
      async () => {
        // Onboarding step 2 notices the reviews and offers the next step.
        await page.goto(dashboardUrl(`/app/onboarding/${projectSlug}/reviews`));
        await page.getByRole("link", { name: "Continue to indexing" }).click();
        await page.waitForURL(/\/indexing$/);
        await waitForIndexed(page);
        // The API agrees, review by review.
        const listed = await listReviews(secretKey);
        const ours = new Set(stored.map((r) => r.id));
        const statuses = listed
          .filter((r) => ours.has(r.id))
          .map((r) => r.status);
        expect(statuses).toEqual(reviews.map(() => "indexed"));
      },
    );

    await step(
      "8. query (POST /v1/query) finds the right sentence",
      async () => {
        const targetId = stored[TARGET_INDEX]?.id;
        const res = await query(secretKey, TARGET_QUERY);
        expect(res.match, JSON.stringify(res).slice(0, 800)).toBe("query");
        const top = res.results[0];
        expect(top, "at least one result").toBeDefined();
        if (!top) return;
        expect(top.review.id).toBe(targetId);
        expect(top.matched).toBe(true);
        expect(top.excerpt).toContain(TARGET_MARKER);
        // The excerpt is one sentence of a longer review, and the highlight
        // says exactly where: text.slice(start, end) === excerpt.
        expect(top.highlight).not.toBeNull();
        const text = top.review.text ?? "";
        const { start, end } = top.highlight ?? { start: 0, end: 0 };
        expect(text.slice(start, end)).toBe(top.excerpt);
        expect(end - start).toBeLessThan(text.length);
      },
    );

    await step(
      "9. snippet step: the tag and the live preview (onboarding step 4)",
      async () => {
        await page.goto(dashboardUrl(`/app/onboarding/${projectSlug}/snippet`));
        const tag = page.getByTestId("snippet-tag");
        await expect(tag).toContainText(`${target.cdnUrl}/v1.js`);
        await expect(tag).toContainText('data-key="pq_pk_live_');
        // The preview iframe loads the real snippet from the cdn, on the
        // dashboard's origin, against this project.
        const preview = page.frameLocator('iframe[title="Snippet preview"]');
        await expect(preview.locator(".pq-item").first()).toBeVisible({
          timeout: 30_000,
        });
        await page
          .getByRole("button", { name: "Finish and open the playground" })
          .click();
        await page.waitForURL(
          new RegExp(`/app/projects/${projectSlug}/playground$`),
        );
      },
    );

    await step(
      "10. snippet renders the review on a customer page",
      async () => {
        await renderSnippetOnTestPage(page, publishableKey);
      },
    );

    await step(
      "11. Google Takeout: a tiny reviews.json into the test environment",
      async () => {
        await importTinyTakeout(page, projectSlug);
      },
    );
  } catch (error) {
    await describeFailure(page, currentStep, error);
    throw error;
  } finally {
    // Cleanup never masks the failure above: each step's error is logged
    // and the first one fails the test only if everything else passed.
    cleanupError = await cleanUp(page, { email, slug });
  }
  if (cleanupError) throw cleanupError;
});

/**
 * The Takeout import through the real page: one `reviews.json` page (a
 * review with text and a star-only one, invented), read in the browser,
 * posted, run. Into the **test** environment, so the live queries above
 * are untouched; the project is deleted at cleanup. Costs one indexed
 * review.
 */
async function importTinyTakeout(page: Page, projectSlug: string) {
  const location = `at${runId.replace(/[^A-Za-z0-9]/g, "")}`;
  const reviews = {
    reviews: [
      {
        reviewer: { displayName: "Acceptance Reviewer" },
        starRating: "FIVE",
        comment: `Takeout acceptance review ${runId}: the bread was fresh.`,
        createTime: "2026-01-02T10:00:00.000000Z",
        updateTime: "2026-01-02T10:00:00.000000Z",
        name: `accounts/1/locations/${location}/reviews/text`,
        reviewReply: { comment: "Thanks!", updateTime: "2026-01-03T10:00:00Z" },
      },
      {
        reviewer: { displayName: "Stars Only" },
        starRating: "FOUR",
        createTime: "2026-01-04T10:00:00.000000Z",
        updateTime: "2026-01-04T10:00:00.000000Z",
        name: `accounts/1/locations/${location}/reviews/stars`,
      },
    ],
  };
  await page.goto(dashboardUrl(`/app/projects/${projectSlug}/import/takeout`));
  await page.getByLabel("Takeout export").setInputFiles({
    name: "reviews.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(reviews)),
  });
  await page.getByRole("radio", { name: /^Test/ }).check();
  await page.getByRole("button", { name: "Import 1 review" }).click();
  await page.waitForURL(
    new RegExp(`/app/projects/${projectSlug}/import/[0-9a-f-]{36}$`),
  );
  await expect(
    page.getByRole("heading", { name: "Import finished" }),
  ).toBeVisible({ timeout: 60_000 });
  const result = page.getByRole("region", { name: "What happened" });
  await expect(result).toContainText("1 review created");
  await expect(result).toContainText("1 star-only skipped");
}

/** Anything shaped like an API key or a Clerk token, for log lines. */
function redact(text: string): string {
  return text
    .replace(/pq_(sk|pk)_(live|test)_[A-Za-z0-9_-]+/g, "pq_$1_$2_****")
    .replace(/(sk|pk)_(live|test)_[A-Za-z0-9]+/g, "$1_$2_****")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt>");
}

/**
 * What a failure looked like, in words: the step, the page's URL (path
 * only) and the visible error text (alerts, form errors, Clerk's field
 * errors), keys redacted. Prod captures no screenshots, traces or reports
 * (playwright.config.ts), so this log line is what debugging starts from;
 * preview prints it too.
 */
async function describeFailure(
  page: Page,
  stepName: string,
  error: unknown,
): Promise<void> {
  let path = "(unknown)";
  let visible: string[] = [];
  try {
    path = new URL(page.url()).pathname;
    visible = await page
      .locator(
        '[role="alert"], [aria-live="polite"], .text-danger, [class*="formFieldErrorText"], [class*="alertText"], h1',
      )
      .evaluateAll((els) =>
        els
          .map((el) => (el as HTMLElement).innerText.trim())
          .filter((t) => t.length > 0)
          .slice(0, 8),
      );
  } catch {
    // The page may be gone (crash, closed context); the step name still helps.
  }
  const message =
    error instanceof Error ? error.message.split("\n")[0] : String(error);
  console.error(
    redact(
      `[at] FAILED at "${stepName}" on ${path}: ${message}${visible.length ? ` | visible: ${visible.join(" / ")}` : ""}`,
    ),
  );
}

async function cleanUp(
  page: Page,
  { email, slug }: { email: string | undefined; slug: string | undefined },
): Promise<unknown> {
  const errors: unknown[] = [];
  const attempt = async (name: string, fn: () => Promise<void>) => {
    try {
      await test.step(name, fn);
    } catch (error) {
      console.error(`[at] ${name} failed:`, error);
      errors.push(error);
    }
  };
  await attempt("cleanup: delete the project", async () => {
    // Every project, not just ours: a half-created one counts too.
    try {
      for (const leftover of await listProjectSlugs(page)) {
        await deleteProject(page, leftover);
      }
    } catch (error) {
      // Before a project existed (sign-in or workspace failed) there may be
      // no app to clean up in; the next run's step 3 catches the rest.
      if (slug) throw error;
    }
  });
  if (target.auth === "sign-up" && email) {
    const testEmail = email;
    await attempt(
      "cleanup: delete the Clerk test user and its workspace",
      async () => {
        await deleteTestUserByEmail(testEmail);
      },
    );
  } else if (email) {
    await attempt("cleanup: sign out", async () => {
      await clerk.signOut({ page });
    });
  }
  return errors[0];
}

/**
 * Onboarding step 3 polls on its own; its heading turns to "Indexed" once
 * every review is searchable. The page stops polling after a while (a
 * forgotten tab costs nothing), so reload until the deadline.
 */
async function waitForIndexed(page: Page): Promise<void> {
  const deadline = Date.now() + INDEXING_TIMEOUT_MS;
  const indexed = page.getByRole("heading", { name: "Indexed", exact: true });
  while (true) {
    const left = deadline - Date.now();
    try {
      await expect(indexed).toBeVisible({ timeout: Math.min(45_000, left) });
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        const meter = await page
          .getByRole("region", { name: "Indexing progress" })
          .textContent()
          .catch(() => null);
        throw new Error(
          `not indexed after ${INDEXING_TIMEOUT_MS / 1000}s; the dashboard says: ${meter ?? "(no meter)"}`,
          { cause: error },
        );
      }
      await page.reload();
    }
  }
  // The finished page moves itself on to step 4 after a beat; that move is
  // part of the flow a customer sees.
  await page.waitForURL(/\/snippet$/, { timeout: 15_000 });
}

/**
 * A page on an allowed origin with the two-line integration from
 * packages/snippet/README.md. Playwright serves the HTML itself (the origin
 * has no DNS); the snippet comes from the target's cdn and queries the
 * target's api with the publishable key, so CORS and the allowlist are
 * exercised for real.
 */
async function renderSnippetOnTestPage(
  page: Page,
  publishableKey: string,
): Promise<void> {
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>ProofQL acceptance page</title></head>
  <body>
    <h1>Wheel truing</h1>
    <div id="reviews" data-proofql data-query="${TARGET_QUERY}" data-limit="3" data-highlight="true"></div>
    <script async src="${target.cdnUrl}/v1.js" data-key="${publishableKey}" data-api="${target.apiUrl}"></script>
  </body>
</html>`;
  await page.route(`${TEST_PAGE_ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html }),
  );

  const queryResponse = page.waitForResponse(
    (r) => r.url().startsWith(`${target.apiUrl}/v1/query`),
    { timeout: 30_000 },
  );
  await page.goto(`${TEST_PAGE_ORIGIN}/services/wheels`);
  const res = await queryResponse;
  expect(
    res.status(),
    `GET /v1/query from ${TEST_PAGE_ORIGIN}: ${(await res.text()).slice(0, 300)}`,
  ).toBe(200);
  expect(res.headers()["access-control-allow-origin"]).toBe(TEST_PAGE_ORIGIN);

  const host = page.locator("#reviews");
  await expect(host).toHaveAttribute("data-pq-match", "query");
  await expect(host.locator(".pq-item").first()).toBeVisible();
  await expect(host.locator(".pq-mark").first()).toContainText(TARGET_MARKER);
}
