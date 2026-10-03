import { SignIn } from "@clerk/react-router";
import { supportEmailFrom } from "@proofql/core";
import { redirect } from "react-router";

import { SiteFooter } from "~/components/shell/site-footer";
import { authMode } from "~/lib/auth-mode";
import { clerkAppearance } from "~/lib/clerk-appearance";
import { getCloudflare } from "~/lib/context";
import { APP_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from "~/lib/paths";
import type { Route } from "./+types/sign-in";

export function loader({ context }: Route.LoaderArgs) {
  const { env } = getCloudflare(context);
  // The local auth stub has nothing to sign in to.
  if (authMode(env) !== "clerk") throw redirect(APP_PATH);
  return { supportEmail: supportEmailFrom(env.SUPPORT_EMAIL) };
}

export const meta: Route.MetaFunction = () => [{ title: "Sign in · ProofQL" }];

export default function SignInPage({ loaderData }: Route.ComponentProps) {
  return (
    <AuthFrame supportEmail={loaderData.supportEmail}>
      <SignIn
        routing="path"
        path={SIGN_IN_PATH}
        signUpUrl={SIGN_UP_PATH}
        fallbackRedirectUrl={APP_PATH}
        appearance={clerkAppearance}
      />
    </AuthFrame>
  );
}

/**
 * Centered column with the wordmark above Clerk's card (or the waitlist
 * page) and the site footer underneath.
 */
export function AuthFrame({
  supportEmail,
  children,
}: {
  supportEmail: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-surface-page px-6 py-10 font-sans text-ink-900">
      <div className="font-display text-display-sm font-medium tracking-display">
        ProofQL
      </div>
      {children}
      <SiteFooter supportEmail={supportEmail} className="justify-center" />
    </main>
  );
}
