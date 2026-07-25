-- LearnCraft P0 初始数据库迁移：扩展、22 张业务/编排表、索引、外键和更新时间触发器。
-- Embedding Profile 已固定为 siliconflow-bge-m3-v1（1024 维、cosine）；本迁移不创建 HNSW。
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE SCHEMA "agent";
--> statement-breakpoint
CREATE TABLE "agent"."agent_run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"sequence_no" integer NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_agent_run_events_sequence" UNIQUE("agent_run_id","sequence_no"),
	CONSTRAINT "ck_agent_run_events_sequence" CHECK ("agent"."agent_run_events"."sequence_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "agent"."agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_type" varchar(40) NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"target_type" varchar(50) NOT NULL,
	"target_id" uuid NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"trace_id" varchar(128) NOT NULL,
	"graph_version" varchar(100) NOT NULL,
	"prompt_version" varchar(100),
	"input_schema_version" varchar(100) NOT NULL,
	"output_schema_version" varchar(100),
	"requested_model_profile" varchar(100) NOT NULL,
	"actual_model_profile" varchar(100),
	"fallback_reason" varchar(255),
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"input_summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" varchar(100),
	"error_summary" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_agent_runs_idempotency" UNIQUE("owner_id","run_type","idempotency_key"),
	CONSTRAINT "ck_agent_runs_type" CHECK ("agent"."agent_runs"."run_type" in (
      'assessment_generate', 'assessment_evaluate', 'plan_generate',
      'card_content_generate', 'card_quiz_generate', 'adaptation'
    )),
	CONSTRAINT "ck_agent_runs_status" CHECK ("agent"."agent_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "ck_agent_runs_input_tokens" CHECK ("agent"."agent_runs"."input_tokens" >= 0),
	CONSTRAINT "ck_agent_runs_output_tokens" CHECK ("agent"."agent_runs"."output_tokens" >= 0),
	CONSTRAINT "ck_agent_runs_cost" CHECK ("agent"."agent_runs"."estimated_cost_usd" >= 0),
	CONSTRAINT "ck_agent_runs_retry_count" CHECK ("agent"."agent_runs"."retry_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assessment_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"assessment_item_id" uuid NOT NULL,
	"answer_json" jsonb NOT NULL,
	"is_correct" boolean,
	"score" numeric(8, 2),
	"feedback" text,
	"weakness_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"grading_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"graded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_assessment_answer_item" UNIQUE("attempt_id","assessment_item_id")
);
--> statement-breakpoint
CREATE TABLE "assessment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" varchar(20) DEFAULT 'in_progress' NOT NULL,
	"total_score" numeric(8, 2),
	"max_score" numeric(8, 2),
	"score_percent" numeric(5, 2),
	"mastery_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"grading_version" varchar(50),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"graded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_assessment_attempt_no" UNIQUE("assessment_id","owner_id","attempt_no"),
	CONSTRAINT "ck_assessment_attempts_no" CHECK ("assessment_attempts"."attempt_no" >= 1),
	CONSTRAINT "ck_assessment_attempts_status" CHECK ("assessment_attempts"."status" in (
      'in_progress', 'submitted', 'grading', 'graded', 'invalid', 'grading_failed'
    )),
	CONSTRAINT "ck_assessment_attempts_score_percent" CHECK ("assessment_attempts"."score_percent" is null or "assessment_attempts"."score_percent" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "assessment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"item_type" varchar(30) NOT NULL,
	"prompt" text NOT NULL,
	"options_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer_key_json" jsonb NOT NULL,
	"grading_mode" varchar(30) NOT NULL,
	"rubric_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"explanation" text NOT NULL,
	"skill_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_score" numeric(8, 2) NOT NULL,
	"schema_version" varchar(50) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_assessment_items_ordinal" UNIQUE("assessment_id","ordinal"),
	CONSTRAINT "ck_assessment_items_ordinal" CHECK ("assessment_items"."ordinal" >= 1),
	CONSTRAINT "ck_assessment_items_type" CHECK ("assessment_items"."item_type" in ('single_choice', 'short_answer')),
	CONSTRAINT "ck_assessment_items_grading_mode_value" CHECK ("assessment_items"."grading_mode" in ('deterministic', 'ai_rubric')),
	CONSTRAINT "ck_assessment_items_max_score" CHECK ("assessment_items"."max_score" > 0),
	CONSTRAINT "ck_assessment_item_grading_mode" CHECK ((
      "assessment_items"."item_type" = 'single_choice'
      and "assessment_items"."grading_mode" = 'deterministic'
      and jsonb_typeof("assessment_items"."options_json") = 'array'
      and jsonb_array_length("assessment_items"."options_json") >= 2
    ) or (
      "assessment_items"."item_type" = 'short_answer'
      and "assessment_items"."grading_mode" = 'ai_rubric'
      and jsonb_typeof("assessment_items"."options_json") = 'array'
      and "assessment_items"."options_json" = '[]'::jsonb
      and "assessment_items"."rubric_json" <> '{}'::jsonb
    ))
);
--> statement-breakpoint
CREATE TABLE "assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"plan_id" uuid,
	"plan_node_id" uuid,
	"kind" varchar(30) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" varchar(30) DEFAULT 'generating' NOT NULL,
	"schema_version" varchar(50) NOT NULL,
	"generation_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_score" numeric(8, 2),
	"max_score" numeric(8, 2),
	"score_percent" numeric(5, 2),
	"mastery_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_assessments_version" CHECK ("assessments"."version" >= 1),
	CONSTRAINT "ck_assessments_kind" CHECK ("assessments"."kind" in ('diagnostic', 'card_quiz')),
	CONSTRAINT "ck_assessments_status" CHECK ("assessments"."status" in (
      'generating', 'ready', 'in_progress', 'submitted', 'grading', 'graded', 'failed', 'archived'
    )),
	CONSTRAINT "ck_assessments_score_percent" CHECK ("assessments"."score_percent" is null or "assessments"."score_percent" between 0 and 100),
	CONSTRAINT "ck_assessment_scope" CHECK ((
      "assessments"."kind" = 'diagnostic' and "assessments"."plan_node_id" is null
    ) or (
      "assessments"."kind" = 'card_quiz' and "assessments"."plan_node_id" is not null
    ))
);
--> statement-breakpoint
CREATE TABLE "card_content_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_content_id" uuid NOT NULL,
	"content_source_id" uuid NOT NULL,
	"content_document_id" uuid,
	"content_chunk_id" uuid,
	"ordinal" integer NOT NULL,
	"citation_label" varchar(300) NOT NULL,
	"locator_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation_status" varchar(20) DEFAULT 'verified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_card_content_references_ordinal" UNIQUE("card_content_id","ordinal"),
	CONSTRAINT "ck_card_content_references_ordinal" CHECK ("card_content_references"."ordinal" >= 1),
	CONSTRAINT "ck_card_content_references_status" CHECK ("card_content_references"."validation_status" in ('verified', 'stale', 'invalid'))
);
--> statement-breakpoint
CREATE TABLE "card_contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"plan_node_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" varchar(20) DEFAULT 'generating' NOT NULL,
	"schema_version" varchar(50) NOT NULL,
	"public_content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runner_spec_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generation_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" char(64),
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_card_contents_node_version" UNIQUE("plan_node_id","version"),
	CONSTRAINT "ck_card_contents_version" CHECK ("card_contents"."version" >= 1),
	CONSTRAINT "ck_card_contents_status" CHECK ("card_contents"."status" in ('generating', 'ready', 'failed', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "content_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
	"embedding" vector(1024),
	"embedding_model" varchar(150),
	"embedding_version" varchar(100),
	"chunker_version" varchar(100) NOT NULL,
	"token_count" integer,
	"source_locator" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_content_chunks_document_ordinal" UNIQUE("document_id","ordinal"),
	CONSTRAINT "ck_content_chunks_ordinal" CHECK ("content_chunks"."ordinal" >= 0),
	CONSTRAINT "ck_content_chunks_token_count" CHECK ("content_chunks"."token_count" is null or "content_chunks"."token_count" >= 0),
	CONSTRAINT "ck_content_chunks_embedding_metadata" CHECK ((
      "content_chunks"."embedding" is null
      and "content_chunks"."embedding_model" is null
      and "content_chunks"."embedding_version" is null
    ) or (
      "content_chunks"."embedding" is not null
      and "content_chunks"."embedding_model" is not null
      and "content_chunks"."embedding_version" is not null
    ))
);
--> statement-breakpoint
CREATE TABLE "content_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"source_uri" text NOT NULL,
	"object_uri" text,
	"content_sha256" char(64),
	"mime_type" varchar(120),
	"parser_name" varchar(100),
	"parser_version" varchar(100),
	"page_count" integer,
	"parsed_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_content_documents_source_hash" UNIQUE("source_id","content_sha256"),
	CONSTRAINT "ck_content_documents_status" CHECK ("content_documents"."status" in ('pending', 'parsed', 'indexed', 'failed', 'archived')),
	CONSTRAINT "ck_content_documents_page_count" CHECK ("content_documents"."page_count" is null or "content_documents"."page_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "content_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visibility" varchar(20) DEFAULT 'catalog' NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"title" varchar(500) NOT NULL,
	"canonical_url" text NOT NULL,
	"provider_name" varchar(120),
	"language" varchar(20) DEFAULT 'zh-CN' NOT NULL,
	"technology_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"license_note" text,
	"verification_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_content_sources_visibility" CHECK ("content_sources"."visibility" = 'catalog'),
	CONSTRAINT "ck_content_sources_type" CHECK ("content_sources"."source_type" in ('document', 'video', 'web')),
	CONSTRAINT "ck_content_sources_verification_status" CHECK ("content_sources"."verification_status" in ('pending', 'verified', 'invalid', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_hash" char(64),
	"user_agent" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "ck_auth_sessions_expiry" CHECK ("auth_sessions"."expires_at" > "auth_sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"password_hash" text NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "ck_users_status" CHECK ("users"."status" in ('active', 'suspended', 'pending_deletion'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_key" varchar(300) NOT NULL,
	"scope" varchar(120) NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"request_hash" char(64) NOT NULL,
	"status" varchar(20) DEFAULT 'processing' NOT NULL,
	"response_status" integer,
	"resource_type" varchar(80),
	"resource_id" uuid,
	"response_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_idempotency_actor_scope_key" UNIQUE("actor_key","scope","idempotency_key"),
	CONSTRAINT "ck_idempotency_keys_status" CHECK ("idempotency_keys"."status" in ('processing', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" varchar(80) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"payload_json" jsonb NOT NULL,
	"trace_id" varchar(128),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" varchar(100),
	"locked_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_outbox_events_status" CHECK ("outbox_events"."status" in ('pending', 'processing', 'published', 'failed', 'dead')),
	CONSTRAINT "ck_outbox_events_attempt_count" CHECK ("outbox_events"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "adaptation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"trigger_node_id" uuid NOT NULL,
	"event_type" varchar(30) NOT NULL,
	"policy_version" varchar(50) NOT NULL,
	"evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_adaptation_events_type" CHECK ("adaptation_events"."event_type" in (
      'unlock', 'recommend_review', 'insert_reinforcement', 'accelerate', 'skip'
    ))
);
--> statement-breakpoint
CREATE TABLE "learning_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"summary" text,
	"status" varchar(30) DEFAULT 'generating' NOT NULL,
	"schema_version" varchar(50) NOT NULL,
	"generation_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_learning_plans_goal_version" UNIQUE("goal_id","version"),
	CONSTRAINT "ck_learning_plans_version" CHECK ("learning_plans"."version" >= 1),
	CONSTRAINT "ck_learning_plans_status" CHECK ("learning_plans"."status" in ('generating', 'active', 'superseded', 'failed', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "plan_node_prerequisites" (
	"node_id" uuid NOT NULL,
	"prerequisite_node_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_node_prerequisites_node_id_prerequisite_node_id_pk" PRIMARY KEY("node_id","prerequisite_node_id"),
	CONSTRAINT "ck_plan_node_not_self_prerequisite" CHECK ("plan_node_prerequisites"."node_id" <> "plan_node_prerequisites"."prerequisite_node_id")
);
--> statement-breakpoint
CREATE TABLE "plan_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"parent_node_id" uuid,
	"node_key" varchar(100) NOT NULL,
	"ordinal" integer NOT NULL,
	"phase" varchar(20) NOT NULL,
	"node_kind" varchar(20) DEFAULT 'core' NOT NULL,
	"title" varchar(255) NOT NULL,
	"learning_objective" text NOT NULL,
	"rationale" text,
	"difficulty" smallint NOT NULL,
	"estimated_minutes" integer NOT NULL,
	"completion_criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(30) DEFAULT 'locked' NOT NULL,
	"content_status" varchar(30) DEFAULT 'not_requested' NOT NULL,
	"inserted_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_plan_nodes_key" UNIQUE("plan_id","node_key"),
	CONSTRAINT "uq_plan_nodes_ordinal" UNIQUE("plan_id","ordinal"),
	CONSTRAINT "ck_plan_nodes_ordinal" CHECK ("plan_nodes"."ordinal" >= 1),
	CONSTRAINT "ck_plan_nodes_phase" CHECK ("plan_nodes"."phase" in ('concept', 'syntax', 'practice', 'debug')),
	CONSTRAINT "ck_plan_nodes_kind" CHECK ("plan_nodes"."node_kind" in ('core', 'reinforcement', 'advanced')),
	CONSTRAINT "ck_plan_nodes_difficulty" CHECK ("plan_nodes"."difficulty" between 1 and 5),
	CONSTRAINT "ck_plan_nodes_estimated_minutes" CHECK ("plan_nodes"."estimated_minutes" between 5 and 1440),
	CONSTRAINT "ck_plan_nodes_status" CHECK ("plan_nodes"."status" in (
      'locked', 'available', 'in_progress', 'completed', 'needs_review', 'skipped'
    )),
	CONSTRAINT "ck_plan_nodes_content_status" CHECK ("plan_nodes"."content_status" in ('not_requested', 'generating', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "code_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"plan_node_id" uuid NOT NULL,
	"card_content_id" uuid,
	"idempotency_key" varchar(255) NOT NULL,
	"runner_job_id" varchar(255),
	"runtime" varchar(50) DEFAULT 'python-3.11' NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"source_code" text NOT NULL,
	"stdin_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stdout" text,
	"stderr" text,
	"exit_code" integer,
	"test_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resource_usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" varchar(100),
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_code_runs_owner_idempotency" UNIQUE("owner_id","idempotency_key"),
	CONSTRAINT "ck_code_runs_status" CHECK ("code_runs"."status" in (
      'queued', 'running', 'succeeded', 'failed', 'timeout', 'rejected', 'cancelled'
    ))
);
--> statement-breakpoint
CREATE TABLE "learner_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"current_level" varchar(20) NOT NULL,
	"primary_language" varchar(20) DEFAULT 'zh-CN' NOT NULL,
	"weekly_minutes" integer NOT NULL,
	"operating_system" varchar(30),
	"background_summary" text,
	"preferences_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"profile_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_learner_profiles_current_level" CHECK ("learner_profiles"."current_level" in ('beginner', 'intermediate', 'advanced')),
	CONSTRAINT "ck_learner_profiles_weekly_minutes" CHECK ("learner_profiles"."weekly_minutes" between 30 and 10080),
	CONSTRAINT "ck_learner_profiles_version" CHECK ("learner_profiles"."profile_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "learning_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"subject_key" varchar(80) NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"desired_outcome" text NOT NULL,
	"target_date" date,
	"weekly_minutes_override" integer,
	"profile_version" integer NOT NULL,
	"status" varchar(30) DEFAULT 'draft' NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_learning_goals_subject" CHECK ("learning_goals"."subject_key" = 'python-311-basics'),
	CONSTRAINT "ck_learning_goals_profile_version" CHECK ("learning_goals"."profile_version" >= 1),
	CONSTRAINT "ck_learning_goals_weekly_minutes_override" CHECK ("learning_goals"."weekly_minutes_override" is null or "learning_goals"."weekly_minutes_override" between 30 and 10080),
	CONSTRAINT "ck_learning_goals_status" CHECK ("learning_goals"."status" in (
      'draft', 'assessment_pending', 'assessment_in_progress', 'planning',
      'active', 'completed', 'archived', 'failed'
    ))
);
--> statement-breakpoint
ALTER TABLE "agent"."agent_run_events" ADD CONSTRAINT "agent_run_events_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "agent"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent"."agent_runs" ADD CONSTRAINT "agent_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_answers" ADD CONSTRAINT "assessment_answers_attempt_id_assessment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."assessment_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_answers" ADD CONSTRAINT "assessment_answers_assessment_item_id_assessment_items_id_fk" FOREIGN KEY ("assessment_item_id") REFERENCES "public"."assessment_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_goal_id_learning_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."learning_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_plan_id_learning_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."learning_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_plan_node_id_plan_nodes_id_fk" FOREIGN KEY ("plan_node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_content_references" ADD CONSTRAINT "card_content_references_card_content_id_card_contents_id_fk" FOREIGN KEY ("card_content_id") REFERENCES "public"."card_contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_content_references" ADD CONSTRAINT "card_content_references_content_source_id_content_sources_id_fk" FOREIGN KEY ("content_source_id") REFERENCES "public"."content_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_content_references" ADD CONSTRAINT "card_content_references_content_document_id_content_documents_id_fk" FOREIGN KEY ("content_document_id") REFERENCES "public"."content_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_content_references" ADD CONSTRAINT "card_content_references_content_chunk_id_content_chunks_id_fk" FOREIGN KEY ("content_chunk_id") REFERENCES "public"."content_chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_contents" ADD CONSTRAINT "card_contents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_contents" ADD CONSTRAINT "card_contents_plan_node_id_plan_nodes_id_fk" FOREIGN KEY ("plan_node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chunks" ADD CONSTRAINT "content_chunks_document_id_content_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."content_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_documents" ADD CONSTRAINT "content_documents_source_id_content_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."content_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adaptation_events" ADD CONSTRAINT "adaptation_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adaptation_events" ADD CONSTRAINT "adaptation_events_plan_id_learning_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."learning_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adaptation_events" ADD CONSTRAINT "adaptation_events_trigger_node_id_plan_nodes_id_fk" FOREIGN KEY ("trigger_node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_plans" ADD CONSTRAINT "learning_plans_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_plans" ADD CONSTRAINT "learning_plans_goal_id_learning_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."learning_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_node_prerequisites" ADD CONSTRAINT "plan_node_prerequisites_node_id_plan_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_node_prerequisites" ADD CONSTRAINT "plan_node_prerequisites_prerequisite_node_id_plan_nodes_id_fk" FOREIGN KEY ("prerequisite_node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_plan_id_learning_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."learning_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_parent_node_id_plan_nodes_id_fk" FOREIGN KEY ("parent_node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_runs" ADD CONSTRAINT "code_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_runs" ADD CONSTRAINT "code_runs_goal_id_learning_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."learning_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_runs" ADD CONSTRAINT "code_runs_plan_node_id_plan_nodes_id_fk" FOREIGN KEY ("plan_node_id") REFERENCES "public"."plan_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_runs" ADD CONSTRAINT "code_runs_card_content_id_card_contents_id_fk" FOREIGN KEY ("card_content_id") REFERENCES "public"."card_contents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learner_profiles" ADD CONSTRAINT "learner_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_run_events_run_sequence" ON "agent"."agent_run_events" USING btree ("agent_run_id","sequence_no");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_owner_status_created" ON "agent"."agent_runs" USING btree ("owner_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_agent_runs_target" ON "agent"."agent_runs" USING btree ("target_type","target_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_assessment_attempts_owner_assessment" ON "assessment_attempts" USING btree ("owner_id","assessment_id","attempt_no" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_assessments_owner_goal_kind" ON "assessments" USING btree ("owner_id","goal_id","kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_card_contents_node_status" ON "card_contents" USING btree ("plan_node_id","status","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_content_chunks_document_ordinal" ON "content_chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "idx_content_chunks_search_tsv" ON "content_chunks" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "idx_content_documents_source_status" ON "content_documents" USING btree ("source_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_content_sources_catalog_url" ON "content_sources" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "idx_auth_sessions_user_active" ON "auth_sessions" USING btree ("user_id","expires_at" DESC NULLS LAST) WHERE "auth_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "idx_auth_sessions_cleanup" ON "auth_sessions" USING btree ("expires_at") WHERE "auth_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "idx_idempotency_keys_expiry" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_events_poll" ON "outbox_events" USING btree ("status","available_at","created_at") WHERE "outbox_events"."status" in ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "idx_adaptation_events_plan_created" ON "adaptation_events" USING btree ("plan_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_learning_plans_one_active_goal" ON "learning_plans" USING btree ("goal_id") WHERE "learning_plans"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_learning_plans_owner_goal" ON "learning_plans" USING btree ("owner_id","goal_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_plan_node_prerequisites_prerequisite" ON "plan_node_prerequisites" USING btree ("prerequisite_node_id");--> statement-breakpoint
CREATE INDEX "idx_plan_nodes_owner_status" ON "plan_nodes" USING btree ("owner_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_code_runs_owner_node_created" ON "code_runs" USING btree ("owner_id","plan_node_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_learning_goals_owner_status" ON "learning_goals" USING btree ("owner_id","status","updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_users_touch_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_auth_sessions_touch_updated_at BEFORE UPDATE ON public.auth_sessions FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_learner_profiles_touch_updated_at BEFORE UPDATE ON public.learner_profiles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_learning_goals_touch_updated_at BEFORE UPDATE ON public.learning_goals FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_learning_plans_touch_updated_at BEFORE UPDATE ON public.learning_plans FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_plan_nodes_touch_updated_at BEFORE UPDATE ON public.plan_nodes FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_assessments_touch_updated_at BEFORE UPDATE ON public.assessments FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_assessment_attempts_touch_updated_at BEFORE UPDATE ON public.assessment_attempts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_assessment_answers_touch_updated_at BEFORE UPDATE ON public.assessment_answers FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_content_sources_touch_updated_at BEFORE UPDATE ON public.content_sources FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_content_documents_touch_updated_at BEFORE UPDATE ON public.content_documents FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_card_contents_touch_updated_at BEFORE UPDATE ON public.card_contents FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_code_runs_touch_updated_at BEFORE UPDATE ON public.code_runs FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_agent_runs_touch_updated_at BEFORE UPDATE ON "agent".agent_runs FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_idempotency_keys_touch_updated_at BEFORE UPDATE ON public.idempotency_keys FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
