// Start the Google connect (#45): mint PKCE + nonce, sign the state, send
// the browser to Google's consent screen (or the fake's, locally). A
// resource route — GET, no component — so the Connect button is a plain
// link that works before hydration. The callback is
// app/routes/app.integrations.google.callback.ts.
import { data, redirect } from "react-router";

import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import {
  beginConnect,
  CALLBACK_PATH,
  connectorEnabled,
} from "~/lib/google.server";
import type { Route } from "./+types/app.projects.$slug.integrations.google.connect";

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const { env, log } = getCloudflare(args.context);
  if (!connectorEnabled(env)) {
    throw data("Google connection is pending approval.", { status: 503 });
  }
  const project = await withRequestDb(args.context, (db) =>
    findProjectBySlug(db, account.id, args.params.slug),
  );
  if (!project) throw data(null, { status: 404 });

  const url = await beginConnect({
    env,
    kv: env.CACHE,
    projectId: project.id,
    accountId: account.id,
    redirectUri: new URL(CALLBACK_PATH, args.request.url).toString(),
  });
  log.log("google.connect.started", {
    project_id: project.id,
    account_id: account.id,
  });
  return redirect(url);
}
