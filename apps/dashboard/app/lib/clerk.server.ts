/**
 * Clerk wiring for React Router middleware on Workers.
 *
 * Clerk's `clerkMiddleware()` reads its keys through `getEnvVariable`,
 * which only understands plain `context.cloudflare.env` objects — under
 * `v8_middleware` the context is a RouterContextProvider, so the keys would
 * resolve to "". This wrapper builds the Clerk middleware per request with
 * the keys taken from the Workers env explicitly, and skips Clerk entirely
 * in the local auth stub (app/lib/auth-mode.ts) and for machine endpoints
 * (the Svix webhook, the health check) that carry no session.
 */
import { clerkMiddleware } from "@clerk/react-router/server";
import type { MiddlewareFunction } from "react-router";

import { authMode } from "./auth-mode";
import { getCloudflare } from "./context";
import { APP_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from "./paths";

/** Paths Clerk never sees: no cookies to read, no redirects wanted. */
const CLERK_BYPASS_PREFIXES = ["/webhooks/", "/health"];

export function bypassesClerk(pathname: string): boolean {
  return CLERK_BYPASS_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export const clerkAuthMiddleware: MiddlewareFunction<Response> = async (
  args,
  next,
) => {
  const { env } = getCloudflare(args.context);
  if (authMode(env) !== "clerk") return next();
  if (bypassesClerk(new URL(args.request.url).pathname)) return next();

  return clerkMiddleware({
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    secretKey: env.CLERK_SECRET_KEY,
    signInUrl: SIGN_IN_PATH,
    signUpUrl: SIGN_UP_PATH,
    signInFallbackRedirectUrl: APP_PATH,
    signUpFallbackRedirectUrl: APP_PATH,
  })(args, next);
};
