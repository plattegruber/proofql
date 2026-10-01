import { SignUp } from "@clerk/react-router";
import { redirect } from "react-router";

import { authMode } from "~/lib/auth-mode";
import { clerkAppearance } from "~/lib/clerk-appearance";
import { getCloudflare } from "~/lib/context";
import { APP_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from "~/lib/paths";
import type { Route } from "./+types/sign-up";
import { AuthFrame } from "./sign-in";

export function loader({ context }: Route.LoaderArgs) {
  if (authMode(getCloudflare(context).env) !== "clerk")
    throw redirect(APP_PATH);
  return null;
}

export default function SignUpPage() {
  return (
    <AuthFrame>
      <SignUp
        routing="path"
        path={SIGN_UP_PATH}
        signInUrl={SIGN_IN_PATH}
        fallbackRedirectUrl={APP_PATH}
        appearance={clerkAppearance}
      />
    </AuthFrame>
  );
}
