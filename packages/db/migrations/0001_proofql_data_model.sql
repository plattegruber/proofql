-- pgvector provides halfvec(1024) on review_chunks.embedding (scope.md §2).
-- drizzle-kit does not manage extensions, so this line is hand-written; the
-- rest of this file is the drizzle-kit output for the schema under src/schema.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."api_key_kind" AS ENUM('secret', 'publishable');--> statement-breakpoint
CREATE TYPE "public"."connection_kind" AS ENUM('google');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'needs_reauth', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."ingest_run_kind" AS ENUM('api', 'csv', 'google', 'places');--> statement-breakpoint
CREATE TYPE "public"."ingest_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chunk_kind" AS ENUM('full', 'window');--> statement-breakpoint
CREATE TYPE "public"."sentiment" AS ENUM('positive', 'neutral', 'negative');--> statement-breakpoint
CREATE TYPE "public"."sentiment_source" AS ENUM('rating', 'model');--> statement-breakpoint
CREATE TYPE "public"."environment" AS ENUM('live', 'test');--> statement-breakpoint
CREATE TYPE "public"."account_plan" AS ENUM('free', 'paid');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "api_key_kind" NOT NULL,
	"environment" "environment" NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "connection_kind" NOT NULL,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"credentials" text,
	"cursor" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_project_id_kind_unique" UNIQUE("project_id","kind")
);
--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" "environment" NOT NULL,
	"kind" "ingest_run_kind" NOT NULL,
	"status" "ingest_run_status" DEFAULT 'running' NOT NULL,
	"received" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"artifact_key" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" "environment" NOT NULL,
	"kind" "chunk_kind" NOT NULL,
	"text" text NOT NULL,
	"start_offset" integer NOT NULL,
	"embedding" halfvec(1024),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_chunks_start_offset_nonnegative" CHECK ("review_chunks"."start_offset" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" "environment" NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"rating" smallint,
	"text" text NOT NULL,
	"author_name" text,
	"author_avatar_url" text,
	"occurred_at" timestamp with time zone,
	"url" text,
	"language" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sentiment" "sentiment",
	"sentiment_source" "sentiment_source",
	"hidden_at" timestamp with time zone,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_project_env_source_external_id_unique" UNIQUE("project_id","environment","source","external_id"),
	CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" IS NULL OR ("reviews"."rating" BETWEEN 1 AND 5))
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_org_id" text NOT NULL,
	"name" text NOT NULL,
	"plan" "account_plan" DEFAULT 'free' NOT NULL,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_clerk_org_id_unique" UNIQUE("clerk_org_id"),
	CONSTRAINT "accounts_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"allowed_origins" text[] DEFAULT '{}' NOT NULL,
	"min_rating" smallint DEFAULT 4 NOT NULL,
	"similarity_floor" double precision DEFAULT 0.55 NOT NULL,
	"show_badge" boolean DEFAULT true NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"project_id" uuid NOT NULL,
	"month" date NOT NULL,
	"queries" integer DEFAULT 0 NOT NULL,
	"cache_hits" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_project_id_month_pk" PRIMARY KEY("project_id","month")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_chunks" ADD CONSTRAINT "review_chunks_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_chunks" ADD CONSTRAINT "review_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_project_id_idx" ON "api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ingest_runs_project_id_started_at_idx" ON "ingest_runs" USING btree ("project_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "review_chunks_project_id_environment_idx" ON "review_chunks" USING btree ("project_id","environment");--> statement-breakpoint
CREATE INDEX "review_chunks_tsv_gin_idx" ON "review_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "review_chunks_review_id_idx" ON "review_chunks" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "reviews_project_id_environment_idx" ON "reviews" USING btree ("project_id","environment");--> statement-breakpoint
CREATE INDEX "projects_account_id_idx" ON "projects" USING btree ("account_id");