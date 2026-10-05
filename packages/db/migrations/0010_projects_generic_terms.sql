-- #149: per-project generic query words. The floor's partial word match
-- ignores lexemes that are in more than a quarter of a project's live
-- reviews (dental: "dentist", "teeth"; a cafe: "coffe"), derived from
-- document frequency by `refreshGenericTerms` in @proofql/db instead of a
-- hard-coded dental list. Additive: the column starts empty, which the
-- search reads as "only the universal words", so this is safe ahead of the
-- code that fills it (expand -> migrate -> contract).
ALTER TABLE "projects" ADD COLUMN "generic_terms" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "generic_terms_refreshed_at" timestamp with time zone;