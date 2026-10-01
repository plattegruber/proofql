// Route paths shared by server code (redirects, Clerk middleware options)
// and components (Clerk's prebuilt UI props). Kept out of *.server.ts so
// client bundles can import them.
export const APP_PATH = "/app";
export const WORKSPACE_PATH = "/app/workspace";
export const SIGN_IN_PATH = "/sign-in";
export const SIGN_UP_PATH = "/sign-up";
