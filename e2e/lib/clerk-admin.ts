/**
 * Clerk Backend API housekeeping for the preview run's throwaway users.
 * Never used against prod: prod signs in a long-lived dedicated user and
 * keeps it (and its workspace) between runs.
 *
 * Deleting a test user's Organization first matters: Clerk sends
 * `organization.deleted` to the dashboard's webhook, which soft-deletes the
 * `accounts` row (and the pipeline's daily purge hard-deletes it after the
 * grace period, #169). The dashboard has no in-app "delete workspace" flow,
 * so this is the closest thing to a customer closing their account.
 */
import { createClerkClient } from "@clerk/backend";

import {
  TEST_EMAIL_PATTERN,
  TEST_EMAIL_PREFIX,
  TEST_WORKSPACE_PREFIX,
} from "./target";

type Clerk = ReturnType<typeof createClerkClient>;

function client(): Clerk {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error("CLERK_SECRET_KEY is not set");
  return createClerkClient({ secretKey });
}

function primaryEmail(user: {
  emailAddresses: { emailAddress: string }[];
}): string {
  return user.emailAddresses[0]?.emailAddress.toLowerCase() ?? "";
}

/**
 * Delete one test user: its acceptance-test workspaces (only ones named
 * `AT …`, and only test users are ever passed here), then the user.
 * Returns what was deleted, for the log line.
 */
async function deleteTestUser(
  clerk: Clerk,
  user: { id: string; emailAddresses: { emailAddress: string }[] },
): Promise<{ orgs: number }> {
  if (!TEST_EMAIL_PATTERN.test(primaryEmail(user))) {
    throw new Error(`refusing to delete non-test user ${user.id}`);
  }
  let orgs = 0;
  const memberships = await clerk.users
    .getOrganizationMembershipList({ userId: user.id, limit: 20 })
    .catch((error: unknown) => {
      // An instance with Organizations switched off has no workspaces to
      // delete; the user still goes.
      if (isOrganizationsDisabled(error)) return { data: [] };
      throw error;
    });
  for (const m of memberships.data) {
    if (!m.organization.name.startsWith(TEST_WORKSPACE_PREFIX)) continue;
    await clerk.organizations.deleteOrganization(m.organization.id);
    orgs += 1;
  }
  await clerk.users.deleteUser(user.id);
  return { orgs };
}

function isOrganizationsDisabled(error: unknown): boolean {
  const errors = (error as { errors?: { code?: string }[] } | null)?.errors;
  return (
    Array.isArray(errors) &&
    errors.some((e) => e.code === "organization_not_enabled_in_instance")
  );
}

/** Delete the user with this exact (test) address, if it exists. */
export async function deleteTestUserByEmail(email: string): Promise<boolean> {
  const clerk = client();
  const users = await clerk.users.getUserList({ emailAddress: [email] });
  const user = users.data[0];
  if (!user) return false;
  const { orgs } = await deleteTestUser(clerk, user);
  console.log(`[at] deleted Clerk test user and ${orgs} workspace(s)`);
  return true;
}

/**
 * Sweep test users left behind by runs that died before their own cleanup:
 * every `proofql-at-*+clerk_test@example.com` user created more than
 * `olderThanMs` ago (so a concurrent run's user is never touched).
 */
export async function sweepStaleTestUsers(
  olderThanMs = 60 * 60 * 1000,
): Promise<number> {
  const clerk = client();
  const cutoff = Date.now() - olderThanMs;
  const users = await clerk.users.getUserList({
    query: TEST_EMAIL_PREFIX,
    limit: 100,
  });
  let swept = 0;
  for (const user of users.data) {
    if (!TEST_EMAIL_PATTERN.test(primaryEmail(user))) continue;
    if (user.createdAt > cutoff) continue;
    await deleteTestUser(clerk, user);
    swept += 1;
  }
  console.log(`[at] swept ${swept} stale Clerk test user(s)`);
  return swept;
}

/**
 * The sign-up ticket from a Clerk invitation, for instances whose sign-up
 * mode is "restricted": only invited addresses may sign up, and they do it
 * through the same <SignUp/> with `__clerk_ticket` in the URL. The
 * invitation is not mailed (test addresses never receive mail anyway).
 */
export async function invitationTicket(
  email: string,
  redirectUrl: string,
): Promise<string> {
  const invitation = await client().invitations.createInvitation({
    emailAddress: email,
    notify: false,
    ignoreExisting: true,
    expiresInDays: 1,
    redirectUrl,
  });
  const ticket = invitation.url
    ? new URL(invitation.url).searchParams.get("__clerk_ticket")
    : null;
  if (!ticket) throw new Error("the Clerk invitation carries no ticket");
  return ticket;
}

/**
 * The instance's sign-up mode ("public", "restricted", "waitlist") from the
 * Frontend API's public environment document, which <SignUp/> itself reads.
 */
export async function clerkSignUpMode(publishableKey: string): Promise<string> {
  const host = Buffer.from(
    publishableKey.replace(/^pk_(test|live)_/, ""),
    "base64",
  )
    .toString("utf8")
    .replace(/\$$/, "");
  const res = await fetch(`https://${host}/v1/environment`);
  if (!res.ok) throw new Error(`Clerk environment: HTTP ${res.status}`);
  const env = (await res.json()) as {
    user_settings?: { sign_up?: { mode?: string } };
  };
  return env.user_settings?.sign_up?.mode ?? "public";
}
