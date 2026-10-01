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
      // Review detail (#39); a sibling, not a child, so the table does not
      // render above it — the Reviews tab stays active by prefix.
      route("reviews/:id", "routes/app.projects.$slug.reviews.$id.tsx"),
      route("playground", "routes/app.projects.$slug.playground.tsx"),
      route("keys", "routes/app.projects.$slug.keys.tsx"),
      route("settings", "routes/app.projects.$slug.settings.tsx"),
      // CSV / JSON import (#38): upload → map columns → run/result (+ the
      // error report as a resource route).
      route("import", "routes/app.projects.$slug.import._index.tsx"),
      route(
        "import/:runId/map",
        "routes/app.projects.$slug.import.$runId.map.tsx",
      ),
      route("import/:runId", "routes/app.projects.$slug.import.$runId.tsx"),
      route(
        "import/:runId/errors.csv",
        "routes/app.projects.$slug.import.$runId.errors.ts",
      ),
    ]),
  ]),
  // Resource routes (no component).
  route("webhooks/clerk", "routes/webhooks.clerk.ts"),
  route("health", "routes/health.ts"),
  // Anything unmatched 404s through the root ErrorBoundary.
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
