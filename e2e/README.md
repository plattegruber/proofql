# @proofql/e2e: acceptance tests

One Playwright test that walks the whole customer journey against a **deployed**
environment, through the real dashboard, API and snippet:

| Step | What it checks |
|---|---|
| 1 | **preview:** signs up a new user at `/sign-up` (Clerk's `<SignUp/>`, email `proofql-at-<run>+clerk_test@example.com`, code `424242`, random password). **prod:** signs in the dedicated user with a Backend API sign-in token (`clerk.signIn({ emailAddress })`), never signs up |
| 2 | `/app/workspace`: creates the workspace `AT <run>` (or picks the prod user's existing one) |
| 3 | deletes projects an earlier run left behind (the free plan allows one) |
| 4 | onboarding step 1 creates the project |
| 5 | Keys tab: creates a live secret and a live publishable key, adds the test page's origin to Allowed origins |
| 6 | `POST /v1/reviews` with 5 reviews |
| 7 | onboarding steps 2–3: the dashboard sees the reviews and reports "Indexed" (3-minute bound); `GET /v1/reviews` agrees |
| 8 | `POST /v1/query` returns the right review, `match: "query"`, its matching sentence as the excerpt, and `review.text.slice(highlight) === excerpt` |
| 9 | onboarding step 4: the tag points at the target's cdn, the live preview iframe renders reviews, Finish lands on the playground |
| 10 | a page served from an allowed origin with the two-line snippet integration renders the review, with the match in `<mark class="pq-mark">` |
| cleanup | deletes the project (Settings → Danger). preview: deletes the Clerk test user and its workspace through the Backend API. prod: signs out |

Failures name the step (`7. dashboard shows the reviews and finishes indexing`),
and the cleanup steps always run.

## Running it

```sh
pnpm i
pnpm --filter @proofql/e2e exec playwright install chromium   # once
CLERK_SECRET_KEY=sk_test_… pnpm --filter @proofql/e2e at:preview
CLERK_SECRET_KEY=sk_live_… pnpm --filter @proofql/e2e at:prod   # only if you own the prod test user
pnpm --filter @proofql/e2e exec playwright show-report           # after a failure
```

| Variable | Default | Meaning |
|---|---|---|
| `AT_TARGET` | `preview` | `preview` or `prod` |
| `CLERK_SECRET_KEY` | (required) | secret key of the target's Clerk instance: development for preview, production for prod. Used for the testing token (bot protection), the prod sign-in token, and the preview user cleanup |
| `CLERK_PUBLISHABLE_KEY` | from `lib/target.ts` | the instance's publishable key, copied from `apps/dashboard/wrangler.jsonc`; keep the two in step |
| `AT_PROD_EMAIL` | `acceptance@proofql.dev` | the existing prod user (prod only) |
| `WORKERS_SUBDOMAIN` | `gruberplatte` | preview's workers.dev subdomain |
| `AT_DASHBOARD_URL`, `AT_API_URL`, `AT_CDN_URL` | per target | override any base URL |
| `AT_RUN_ID` | the GitHub run id, or `local-<time>` | goes into the email, workspace, project and review ids |

`pnpm dev` is not a target: locally the dashboard runs on its auth stub
(no Clerk), so there is nothing for steps 1–2 to drive.

## In CI

[`.github/workflows/acceptance.yml`](../.github/workflows/acceptance.yml) runs
the suite after a successful **Deploy** on `main` (for whichever environment
that run deployed), on `workflow_dispatch` (input `target`), and daily at
07:23 UTC (both targets). It is not a PR check and is not required by branch
protection.

| Job | Secret | Where |
|---|---|---|
| `preview` | `CLERK_SECRET_KEY_PREVIEW` | repository secret |
| `prod` | `CLERK_SECRET_KEY_PROD` | environment `acceptance-prod` (main only); the job skips with a notice while it is empty |

Optional repository variable `AT_PROD_EMAIL`. On failure the Playwright
report is uploaded as an artifact (7 days). The repository is public, so
the artifact is too: preview keeps traces and video (the user, keys and
project in them are deleted by the run), prod keeps screenshots only.

Prerequisites on the Clerk side (owner, once per instance): Organizations
enabled with user-created organizations (the dashboard needs a workspace);
for prod, the user `AT_PROD_EMAIL` exists. The suite never changes Clerk
settings, and never turns on test mode in prod.

## Budget

Each run spends, out of the Workers free plan's daily allowances
([docs/launch.md §16](../docs/launch.md#16-running-on-the-free-plan)): 5
reviews indexed (15 queue operations, a handful of KV writes and Workers AI
calls), and a few dozen Workers requests, most of them dashboard page loads
and the indexing page's polling. Preview runs once per deploy to `main` plus
once a day; prod once per prod deploy plus once a day. Keep it that small:
no loops, no load, no retries.

## Leftovers

The free plan allows one project per account, so the run deletes every
project of its account at the start and at the end. A preview run that dies
before its cleanup leaves a `proofql-at-*` Clerk user behind; the next run's
global setup deletes test users older than an hour, with their `AT …`
workspaces. The dashboard has no in-app "delete account" flow, so deleting
the workspace in Clerk is the account deletion: Clerk's
`organization.deleted` webhook soft-deletes the `accounts` row and the
pipeline's daily purge removes it after the grace period (#169).
