// Root: design tokens + webfonts, the Clerk middleware/provider pair, and
// the error boundary. Clerk is mounted only when configured (app/lib/
// auth-mode.ts); in the local auth stub the tree renders without it and
// nothing downstream touches Clerk's hooks.
import { ClerkProvider } from "@clerk/react-router";
import { rootAuthLoader } from "@clerk/react-router/server";
import {
  data,
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import { Overline } from "~/components/shell/page-header";
import { buttonVariants } from "~/components/ui/button";
import { type AuthMode, authMode } from "~/lib/auth-mode";
import { clerkAuthMiddleware } from "~/lib/clerk.server";
import { clerkAppearance } from "~/lib/clerk-appearance";
import { getCloudflare } from "~/lib/context";
import { APP_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from "~/lib/paths";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/root";

import "./app.css";

export const middleware: Route.MiddlewareFunction[] = [clerkAuthMiddleware];

/**
 * Clerk's default copy is exclamatory ("Welcome back!"); the design
 * system's voice is not. Only the strings the prebuilt cards show on
 * first paint are overridden.
 */
const clerkLocalization = {
  signIn: {
    start: {
      title: "Sign in to ProofQL",
      subtitle: "Continue to your workspace",
    },
  },
  signUp: {
    start: {
      title: "Create your ProofQL account",
      subtitle: "A workspace for your reviews, keys and snippet",
    },
  },
};

export const links: Route.LinksFunction = () => [
  // Google-hosted fonts per the design system's tokens/fonts.css (no brand
  // font binaries exist). Self-hosting is a flagged follow-up.
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&family=Space+Grotesk:wght@400;500;600;700&display=swap",
  },
];

export const meta: Route.MetaFunction = () => [{ title: "ProofQL" }];

export async function loader(args: Route.LoaderArgs) {
  const { env } = getCloudflare(args.context);
  const mode: AuthMode = authMode(env);
  if (mode !== "clerk") return data({ mode });
  // rootAuthLoader merges Clerk's SSR state (`clerkState`) into the object
  // the callback returns; <ClerkProvider loaderData> reads it back.
  return rootAuthLoader(args, () => ({ mode }));
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  if (loaderData.mode !== "clerk") return <Outlet />;
  return (
    <ClerkProvider
      loaderData={loaderData}
      appearance={clerkAppearance}
      signInUrl={SIGN_IN_PATH}
      signUpUrl={SIGN_UP_PATH}
      signInFallbackRedirectUrl={APP_PATH}
      signUpFallbackRedirectUrl={APP_PATH}
      localization={clerkLocalization}
    >
      <Outlet />
    </ClerkProvider>
  );
}

/**
 * Root error boundary — an error page is still our product, so it keeps
 * the tokens and the voice. 404s teach the way back; unexpected errors
 * apologize calmly and show the stack only in dev. The way home is a plain
 * anchor: after an error a full document reload is the safest recovery.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let overline = "Error";
  let title = "Something went wrong";
  let body =
    "An unexpected error occurred. Your data is fine. Try again, or come back in a moment.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    overline = `HTTP ${error.status}`;
    if (error.status === 404) {
      title = "This page doesn't exist";
      body =
        "The address may be mistyped, or the page may have moved. The overview is the place to start.";
    } else if (typeof error.data === "string" && error.data) {
      body = error.data;
    } else {
      body = error.statusText || body;
    }
  } else if (import.meta.env.DEV && error instanceof Error) {
    body = error.message;
    stack = error.stack;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-page px-6 font-sans text-ink-900">
      <div className="w-full max-w-140">
        <Overline className="mb-2.5">{overline}</Overline>
        <h1 className="m-0 font-display text-h1 font-medium tracking-display text-ink-900">
          {title}
        </h1>
        <p className="mt-2 mb-0 text-body text-gray-600">{body}</p>
        <a
          href="/app"
          className={cn(
            buttonVariants({ variant: "secondary", size: "sm" }),
            "mt-6 no-underline",
          )}
        >
          Go to the overview
        </a>
        {stack && (
          <pre className="mt-8 max-h-80 overflow-auto border border-hairline bg-surface-sunken p-4 font-mono text-label text-gray-600">
            <code>{stack}</code>
          </pre>
        )}
      </div>
    </main>
  );
}
