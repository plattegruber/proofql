-- #63: project slugs are unique per account, not globally. Two accounts may
-- both name a project "website"; one account may not have two. Corrective
-- migration (0001 is immutable); no projects existed when it shipped, so the
-- new constraint cannot fail on existing rows.
ALTER TABLE "projects" DROP CONSTRAINT "projects_slug_unique";--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_account_id_slug_unique" UNIQUE("account_id","slug");