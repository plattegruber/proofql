/**
 * Test-only: sign a payload the way Svix / Standard Webhooks does, so the
 * verifier can be exercised without Clerk. HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the base64 secret behind `whsec_`,
 * presented as `v1,<base64>`.
 */

export const TEST_SIGNING_SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;

export async function signClerkWebhook(
  body: string,
  opts: {
    secret?: string;
    id?: string;
    timestamp?: number;
  } = {},
): Promise<Record<string, string>> {
  const secret = opts.secret ?? TEST_SIGNING_SECRET;
  const id = opts.id ?? "msg_test_1";
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) =>
    c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return {
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": `v1,${signature}`,
    "content-type": "application/json",
  };
}

export function clerkEvent(
  type: string,
  data: Record<string, unknown>,
): string {
  return JSON.stringify({
    type,
    object: "event",
    data,
    timestamp: Date.now(),
    instance_id: "ins_test",
  });
}
