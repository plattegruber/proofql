-- #51: the pre-launch waitlist. Emails left on /sign-up while public signup
-- is closed (SIGNUP_OPEN, docs/launch.md "Go"). Not tied to an account —
-- nobody on it has one yet. Unique on email so a repeat submission is a
-- no-op; `source` names the surface that collected it. Additive only.
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'sign-up' NOT NULL,
	CONSTRAINT "waitlist_email_unique" UNIQUE("email")
);
