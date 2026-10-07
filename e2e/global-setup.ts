/**
 * Runs once before the suite:
 *
 * 1. `clerkSetup` fetches a Clerk testing token with CLERK_SECRET_KEY, so
 *    `setupClerkTestingToken` / `clerk.signIn` can get the browser past
 *    Clerk's bot protection. It does not change any instance setting.
 * 2. On preview only: sweep `proofql-at-*` test users (and their `AT …`
 *    workspaces) older than an hour that a crashed run left behind.
 */
import { clerkSetup } from "@clerk/testing/playwright";

import { sweepStaleTestUsers } from "./lib/clerk-admin";
import { target } from "./lib/target";

export default async function globalSetup(): Promise<void> {
  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error(
      "CLERK_SECRET_KEY is not set: the secret key of the Clerk instance behind the target (docs: e2e/README.md).",
    );
  }
  console.log(
    `[at] target ${target.name}: dashboard ${target.dashboardUrl}, api ${target.apiUrl}, cdn ${target.cdnUrl}`,
  );
  await clerkSetup({
    publishableKey: target.clerkPublishableKey,
    dotenv: false,
  });
  if (target.name === "preview") await sweepStaleTestUsers();
}
