// Google sends the browser back here after consent (#45): verify the signed
// state and the single-use nonce, exchange the code with the PKCE verifier,
// store the encrypted credentials, discover locations, and land on the
// project's Integrations tab with a flash. One callback URL for every
// project — the project is in the state — so the OAuth client needs exactly
// one redirect URI per environment (infra/provisioning.md).

import { schema } from "@proofql/db";
import { verifyState } from "@proofql/google";
import { and, eq } from "drizzle-orm";
import { data, redirect } from "react-router";
import { requireAccount } from "~/lib/account.server";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import {
  CALLBACK_PATH,
  ConnectError,
  completeConnect,
  connectErrorMessage,
  integrationsPath,
  stateSecret,
} from "~/lib/google.server";
import type { Route } from "./+types/app.integrations.google.callback";

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const { env, log } = getCloudflare(args.context);
  const url = new URL(args.request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");
  if (!state) throw data("Missing state", { status: 400 });

  // Where to land: the project named in the state, if it is ours and still
  // exists; otherwise the overview. Done with a lenient parse so even a
  // refused connect returns the user to the right tab.
  const slug = await withRequestDb(args.context, async (db) => {
    try {
      const parsed = await verifyState(stateSecret(env), state);
      const project = await db.query.projects.findFirst({
        where: and(
          eq(schema.projects.id, parsed.projectId),
          eq(schema.projects.accountId, account.id),
        ),
      });
      return project?.slug ?? null;
    } catch {
      return null;
    }
  });
  const back = slug ? integrationsPath(slug) : "/app";

  if (denied || !code) {
    log.log("google.connect.denied", {
      account_id: account.id,
      error: denied ?? "missing_code",
    });
    return redirect(back, {
      headers: await setFlash(env, {
        tone: "negative",
        message: "Google was not connected",
        detail:
          denied === "access_denied"
            ? "You cancelled the Google sign-in. Nothing was changed."
            : "Google did not return a sign-in code. Try again.",
      }),
    });
  }

  try {
    const result = await withRequestDb(args.context, (db) =>
      completeConnect({
        env,
        kv: env.CACHE,
        log,
        db,
        code,
        state,
        accountId: account.id,
        redirectUri: new URL(CALLBACK_PATH, args.request.url).toString(),
      }),
    );
    const locations = result.discovered?.locations ?? [];
    const verified = locations.filter((l) => l.verified).length;
    log.log("google.connect.completed", {
      project_id: result.projectId,
      connection_id: result.connection.id,
      locations: locations.length,
      verified,
      discovery_error: result.discoveryError,
    });
    const flash = result.discoveryError
      ? {
          tone: "negative" as const,
          message: "Google connected, but its locations could not be listed",
          detail: `Google answered ${result.discoveryError}. Reconnect to try again.`,
        }
      : {
          tone: "positive" as const,
          message: "Google connected",
          detail:
            verified === 0
              ? "No verified locations were found on this Google account."
              : `${locations.length} location${locations.length === 1 ? "" : "s"} found. Choose which ones to sync.`,
        };
    return redirect(back, { headers: await setFlash(env, flash) });
  } catch (error) {
    if (!(error instanceof ConnectError)) throw error;
    log.log("google.connect.rejected", {
      account_id: account.id,
      reason: error.reason,
      detail: error.detail,
    });
    return redirect(back, {
      headers: await setFlash(env, {
        tone: "negative",
        message: "Google was not connected",
        detail: connectErrorMessage(error),
      }),
    });
  }
}
