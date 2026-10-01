// Resource route: `POST /webhooks/clerk` (app/lib/clerk-webhook.server.ts).
// Clerk's middleware is bypassed for this path (no session, no redirects).
import { handleClerkWebhook } from "~/lib/clerk-webhook.server";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import type { Route } from "./+types/webhooks.clerk";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const { env } = getCloudflare(context);
  return withRequestDb(context, (db) =>
    handleClerkWebhook(request, {
      signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET || undefined,
      db,
    }),
  );
}

export function loader() {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}
