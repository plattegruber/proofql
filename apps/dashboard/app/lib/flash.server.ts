// Flash toasts (docs/frontend-conventions.md): a one-shot message set by an
// action, carried across the redirect in a signed cookie session, read (and
// cleared) by the protected layout's loader (app/routes/app.tsx), and
// rendered by its <Toaster />. This is how success toasts survive
// navigation; a fetcher that stays on the page uses a client toast instead.
//
// `createCookieSessionStorage` is Workers-compatible; no KV needed for a
// message this small.
import { createCookieSessionStorage } from "react-router";

export interface FlashMessage {
  tone: "positive" | "negative" | "neutral";
  message: string;
  /** One quieter line under the message, optional. */
  detail?: string;
  /**
   * Random per-flash id. The client keys "already shown" off it, so a
   * revalidation that races the clearing Set-Cookie can't double-toast.
   */
  id: string;
}

/**
 * The env slice flash needs. Structural on purpose: `SESSION_SECRET` is a
 * secret (typed into Env from .dev.vars.example), and tests pass a plain
 * object.
 */
export interface FlashEnv {
  ENVIRONMENT?: string;
  SESSION_SECRET?: string;
}

const COOKIE_NAME = "__pq_flash";

function storage(env: FlashEnv) {
  const configured = env.SESSION_SECRET?.trim() || undefined;
  if (configured === undefined && env.ENVIRONMENT !== "local") {
    // Deployed environments must set the real secret (docs/secrets.md).
    throw new Error("SESSION_SECRET is not set");
  }
  return createCookieSessionStorage<Record<string, never>, { flash: string }>({
    cookie: {
      name: COOKIE_NAME,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secrets: [configured ?? "dev-only-insecure-secret"],
      secure: env.ENVIRONMENT !== "local",
    },
  });
}

/**
 * Headers for a redirect response that carries a flash message. Usage in
 * an action:
 *
 *   return redirect(`/app/projects/${slug}/settings`, {
 *     headers: await setFlash(env, { tone: "positive", message: "Saved" }),
 *   });
 */
export async function setFlash(
  env: FlashEnv,
  flash: Omit<FlashMessage, "id">,
): Promise<Headers> {
  const { getSession, commitSession } = storage(env);
  const session = await getSession();
  session.flash("flash", JSON.stringify({ ...flash, id: crypto.randomUUID() }));
  return new Headers({ "Set-Cookie": await commitSession(session) });
}

/**
 * Read (and clear) the flash message, if any. Called by the layout loader
 * only; everything else reads that loader's data. `headers` is present
 * exactly when there was a message to clear — attach it to the loader's
 * response so the cookie doesn't re-fire.
 */
export async function readFlash(
  env: FlashEnv,
  request: Request,
): Promise<{ flash: FlashMessage | null; headers: Headers | undefined }> {
  const { getSession, commitSession } = storage(env);
  const session = await getSession(request.headers.get("Cookie"));
  const raw = session.get("flash");
  if (raw === undefined) return { flash: null, headers: undefined };
  return {
    flash: JSON.parse(raw) as FlashMessage,
    // session.get consumed the flash; committing writes the cleared cookie.
    headers: new Headers({ "Set-Cookie": await commitSession(session) }),
  };
}
