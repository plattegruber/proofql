import { SignIn } from "@clerk/react-router";
import { redirect } from "react-router";

import { authMode } from "~/lib/auth-mode";
import { clerkAppearance } from "~/lib/clerk-appearance";
import { getCloudflare } from "~/lib/context";
import { APP_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from "~/lib/paths";
import type { Route } from "./+types/sign-in";

export function loader({ context }: Route.LoaderArgs) {
  // The local auth stub has nothing to sign in to.
  if (authMode(getCloudflare(context).env) !== "clerk")
    throw redirect(APP_PATH);
  return null;
}

export default function SignInPage() {
  return (
    <AuthFrame>
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

/** Centered column with the wordmark above Clerk's card. */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-surface-page px-6 font-sans text-ink-900">
      <div className="font-display text-display-sm font-medium tracking-display">
        ProofQL
      </div>
      {children}
    </main>
  );
}
