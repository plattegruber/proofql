/**
 * `POST /webhooks/clerk` — keeps `accounts` in step with Clerk Organizations.
 *
 * Verification is Clerk's `verifyWebhook` (Standard Webhooks / Svix:
 * `svix-id`, `svix-timestamp`, `svix-signature` headers, HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the base64 `whsec_` secret, 5-minute
 * timestamp tolerance). The signing secret is passed explicitly from the
 * Workers env — the SDK's env lookup does not see Workers bindings.
 *
 * Handled: `organization.created|updated` upsert the account by
 * `clerk_org_id`; `organization.deleted` soft-marks it. Every other event
 * type is acknowledged with 200 so Clerk does not retry it. Verification
 * failures are 400; a missing secret is 503 (misconfiguration, not a bad
 * request).
 */
import { verifyWebhook, type WebhookEvent } from "@clerk/react-router/webhooks";
import type { Db } from "@proofql/db";

import { markAccountDeleted, upsertAccountByClerkOrgId } from "./accounts";

/** A Clerk organization event is a few KiB; this is a generous ceiling. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export interface ClerkWebhookResult {
  type: string;
  /** Whether the event changed anything (false for acknowledged-only). */
  handled: boolean;
}

export async function applyClerkEvent(
  db: Db,
  event: WebhookEvent,
): Promise<ClerkWebhookResult> {
  switch (event.type) {
    case "organization.created":
    case "organization.updated": {
      await upsertAccountByClerkOrgId(db, {
        clerkOrgId: event.data.id,
        name: event.data.name,
        // Recorded once (accounts.ts): the free-plan allowance is per person.
        createdByUserId: event.data.created_by ?? null,
      });
      return { type: event.type, handled: true };
    }
    case "organization.deleted": {
      if (!event.data.id) return { type: event.type, handled: false };
      const row = await markAccountDeleted(db, event.data.id);
      return { type: event.type, handled: row !== undefined };
    }
    default:
      return { type: event.type, handled: false };
  }
}

export async function handleClerkWebhook(
  request: Request,
  opts: { signingSecret: string | undefined; db: Db },
): Promise<Response> {
  if (!opts.signingSecret) {
    return Response.json(
      { error: "CLERK_WEBHOOK_SIGNING_SECRET is not set" },
      { status: 503 },
    );
  }

  // Size cap before the signature (#49): a Clerk organization event is a few
  // KiB, so anything near the cap is not Clerk, and HMAC over a large body
  // is work an unauthenticated caller should not be able to buy. Checked
  // from Content-Length first, then on the bytes actually read.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_WEBHOOK_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }

  let event: WebhookEvent;
  try {
    // The body is consumed; hand the verifier a copy carrying the same
    // headers. It checks the three svix headers, the HMAC, and the 5-minute
    // timestamp tolerance (clerk-webhook.server.test.ts "stale timestamp").
    event = await verifyWebhook(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
      }),
      { signingSecret: opts.signingSecret },
    );
  } catch {
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }

  const result = await applyClerkEvent(opts.db, event);
  return Response.json({ ok: true, ...result });
}
