import {
  index,
  layout,
  type RouteConfig,
  route,
} from "@react-router/dev/routes";

export default [
  // "/" is marketing-free: straight to the app.
  index("routes/home.tsx"),
  // Clerk's prebuilt components own everything under these prefixes (the
  // splat covers their multi-step sub-paths). In the local auth stub both
  // redirect to /app.
  route("sign-in/*", "routes/sign-in.tsx"),
  route("sign-up/*", "routes/sign-up.tsx"),
  // Signed in, no active Organization yet: create or pick a workspace.
  // Outside the protected layout on purpose — that layout requires one.
  route("app/workspace", "routes/app.workspace.tsx"),
  // Protected app: the layout's loader is `requireAccount`, so every child
  // runs with an account in hand.
  layout("routes/app.tsx", [
    route("app", "routes/app._index.tsx"),
    route("app/projects/:slug", "routes/app.projects.$slug.tsx", [
      index("routes/app.projects.$slug._index.tsx"),
      route("reviews", "routes/app.projects.$slug.reviews.tsx"),
      route("playground", "routes/app.projects.$slug.playground.tsx"),
      route("keys", "routes/app.projects.$slug.keys.tsx"),
      route("settings", "routes/app.projects.$slug.settings.tsx"),
    ]),
  ]),
  // Resource routes (no component).
  route("webhooks/clerk", "routes/webhooks.clerk.ts"),
  route("health", "routes/health.ts"),
  // Anything unmatched 404s through the root ErrorBoundary.
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
