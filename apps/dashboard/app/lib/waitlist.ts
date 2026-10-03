// Pure rules for the pre-launch waitlist (docs/launch.md "Go"): the form
// schema and the copy. Shared with the browser, so nothing server-side here.
import { z } from "zod";

/** Honeypot field name: hidden from people, filled by naive bots. */
export const WAITLIST_HONEYPOT_FIELD = "website";

/** RFC 5321's practical ceiling; longer strings are not addresses. */
export const WAITLIST_EMAIL_MAX_LENGTH = 254;

/**
 * The /sign-up waitlist form. The address is trimmed and lowercased before
 * the format check so " Ada@Example.com " and "ada@example.com" are one row
 * (the `waitlist.email` unique constraint compares exact strings).
 */
export const waitlistFormSchema = z.object({
  email: z
    .string({ message: "Enter your email address." })
    .trim()
    .toLowerCase()
    .max(WAITLIST_EMAIL_MAX_LENGTH, "That address is too long.")
    .pipe(z.email({ message: "Enter a valid email address." })),
  [WAITLIST_HONEYPOT_FIELD]: z.string().optional(),
});

export type WaitlistFormInput = z.infer<typeof waitlistFormSchema>;

/** Attempts one address (one `cf-connecting-ip`) may make per window. */
export const WAITLIST_RATE_LIMIT = { limit: 5, period: 60 * 60 } as const;

export const WAITLIST_THROTTLED_MESSAGE =
  "Too many attempts from your network. Try again in an hour.";
