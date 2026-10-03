// /sign-up: Clerk's prebuilt sign-up while public signup is open; the
// waitlist page while it is closed (`SIGNUP_OPEN`, app/lib/signup-gate.ts;
// docs/launch.md "Go"). Existing accounts sign in as usual either way — the
// gate is on creating accounts, not on using them.
import { SignUp } from "@clerk/react-router";
import { supportEmailFrom } from "@proofql/core";
import { data, Form, Link, redirect } from "react-router";

import { Field, FormErrors } from "~/components/form/field";
import { SubmitButton } from "~/components/form/submit-button";
import { Overline } from "~/components/shell/page-header";
import { Card } from "~/components/ui/card";
import { authMode } from "~/lib/auth-mode";
import { clerkAppearance } from "~/lib/clerk-appearance";
import { getCloudflare } from "~/lib/context";
import { APP_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from "~/lib/paths";
import { signupOpen } from "~/lib/signup-gate";
import { WAITLIST_HONEYPOT_FIELD } from "~/lib/waitlist";
import { handleWaitlistSubmission } from "~/lib/waitlist.server";
import type { Route } from "./+types/sign-up";
import { AuthFrame } from "./sign-in";

export function loader({ context }: Route.LoaderArgs) {
  const { env } = getCloudflare(context);
  if (authMode(env) !== "clerk") throw redirect(APP_PATH);
  return {
    open: signupOpen(env),
    supportEmail: supportEmailFrom(env.SUPPORT_EMAIL),
  };
}

export const meta: Route.MetaFunction = ({ loaderData }) => [
  {
    title: loaderData?.open
      ? "Sign up · ProofQL"
      : "ProofQL is not open yet · ProofQL",
  },
];

/** The waitlist form posts here; while signup is open there is nothing to post. */
export async function action(args: Route.ActionArgs) {
  const { env } = getCloudflare(args.context);
  if (authMode(env) !== "clerk" || signupOpen(env)) {
    throw data(null, { status: 404 });
  }
  return handleWaitlistSubmission(args);
}

export default function SignUpPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  return (
    <AuthFrame supportEmail={loaderData.supportEmail}>
      {loaderData.open ? (
        <SignUp
          routing="path"
          path={SIGN_UP_PATH}
          signInUrl={SIGN_IN_PATH}
          fallbackRedirectUrl={APP_PATH}
          appearance={clerkAppearance}
        />
      ) : (
        <WaitlistCard joined={actionData?.ok === true} />
      )}
    </AuthFrame>
  );
}

/**
 * "Not open yet": one field, one button, and the way in for people who
 * already have an account. After a successful post the card says so and
 * stops asking; a repeat address gets the same answer (the list is not
 * something the page can be used to probe).
 */
export function WaitlistCard({ joined }: { joined: boolean }) {
  return (
    <Card className="w-full max-w-110">
      <Overline className="mb-2.5">Early access</Overline>
      <h1 className="m-0 font-display text-h1 font-medium tracking-display text-ink-900">
        ProofQL is not open yet
      </h1>
      {joined ? (
        <p role="status" className="mt-2 mb-0 text-body text-gray-600">
          You are on the list. We will email you when signup opens.
        </p>
      ) : (
        <>
          <p className="mt-2 mb-5 text-body text-gray-600">
            Leave your email and we will let you know the day public signup
            opens. Nothing else is sent to it.
          </p>
          <Form method="post" className="flex flex-col gap-4" noValidate>
            <Field
              name="email"
              label="Email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
            />
            {/* Honeypot: hidden from people, filled by naive bots. */}
            <div aria-hidden className="hidden">
              <label htmlFor="waitlist-website">Website</label>
              <input
                id="waitlist-website"
                name={WAITLIST_HONEYPOT_FIELD}
                type="text"
                tabIndex={-1}
                autoComplete="off"
              />
            </div>
            <FormErrors />
            <SubmitButton pendingLabel="Joining…" className="self-start">
              Join the waitlist
            </SubmitButton>
          </Form>
        </>
      )}
      <p className="mt-5 mb-0 border-t border-hairline pt-4 text-small text-gray-600">
        Already have an account?{" "}
        <Link to={SIGN_IN_PATH} className="text-ink-900">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
