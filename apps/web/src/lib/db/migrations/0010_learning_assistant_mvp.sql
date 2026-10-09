-- 学习助手 MVP 的会话、消息、对话运行和学习经历记忆表。
-- 调用顺序：创建会话 → 持久化消息 → 创建/更新对话运行 → 写入经验证的学习经历记忆。

CREATE TABLE "learning_assistant_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"goal_id" uuid,
	"source_assessment_answer_id" uuid,
	"status" varchar(30) DEFAULT 'active' NOT NULL,
	"stage" varchar(40) DEFAULT 'new' NOT NULL,
	"state_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_learning_assistant_conversations_status" CHECK ("learning_assistant_conversations"."status" in ('active', 'completed', 'archived')),
	CONSTRAINT "ck_learning_assistant_conversations_stage" CHECK ("learning_assistant_conversations"."stage" in (
        'new', 'context_loaded', 'diagnosing', 'waiting_for_user', 'hinting',
        'checking_repair', 'mastered', 'needs_more_practice', 'unresolved'
      ))
);
--> statement-breakpoint
CREATE TABLE "learning_assistant_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sequence_no" integer NOT NULL,
	"turn_no" integer NOT NULL,
	"role" varchar(20) NOT NULL,
	"content" text,
	"tool_name" varchar(100),
	"tool_call_id" varchar(150),
	"tool_input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_learning_assistant_messages_sequence" UNIQUE("conversation_id","sequence_no"),
	CONSTRAINT "ck_learning_assistant_messages_role" CHECK ("learning_assistant_messages"."role" in ('user', 'assistant', 'tool')),
	CONSTRAINT "ck_learning_assistant_messages_sequence" CHECK ("learning_assistant_messages"."sequence_no" >= 1),
	CONSTRAINT "ck_learning_assistant_messages_turn" CHECK ("learning_assistant_messages"."turn_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "learning_assistant_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"idempotency_key" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"orchestration_version" varchar(100) NOT NULL,
	"model_id" varchar(255),
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"model_call_count" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"sub_agent_summary_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skill_summary_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tavily_summary_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" varchar(100),
	"error_summary" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_learning_assistant_runs_idempotency" UNIQUE("conversation_id","idempotency_key"),
	CONSTRAINT "ck_learning_assistant_runs_status" CHECK ("learning_assistant_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "ck_learning_assistant_runs_input_tokens" CHECK ("learning_assistant_runs"."input_tokens" >= 0),
	CONSTRAINT "ck_learning_assistant_runs_output_tokens" CHECK ("learning_assistant_runs"."output_tokens" >= 0),
	CONSTRAINT "ck_learning_assistant_runs_model_calls" CHECK ("learning_assistant_runs"."model_call_count" >= 0),
	CONSTRAINT "ck_learning_assistant_runs_tool_calls" CHECK ("learning_assistant_runs"."tool_call_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "learning_experience_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"conversation_id" uuid,
	"source_assessment_answer_id" uuid,
	"source_run_id" uuid,
	"memory_type" varchar(40) NOT NULL,
	"knowledge_point" varchar(200),
	"error_type" varchar(40),
	"pattern" text,
	"evidence_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intervention_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"repair_status" varchar(30) NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_learning_experience_memories_type" CHECK ("learning_experience_memories"."memory_type" in ('error_pattern', 'concept_gap', 'learning_preference', 'intervention_result')),
	CONSTRAINT "ck_learning_experience_memories_repair_status" CHECK ("learning_experience_memories"."repair_status" in ('unverified', 'improving', 'repaired', 'needs_more_practice', 'unresolved')),
	CONSTRAINT "ck_learning_experience_memories_confidence" CHECK ("learning_experience_memories"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE INDEX "idx_learning_assistant_conversations_owner_updated" ON "learning_assistant_conversations" USING btree ("owner_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_learning_assistant_conversations_source_answer" ON "learning_assistant_conversations" USING btree ("source_assessment_answer_id");--> statement-breakpoint
CREATE INDEX "idx_learning_assistant_messages_conversation_turn" ON "learning_assistant_messages" USING btree ("conversation_id","turn_no","sequence_no");--> statement-breakpoint
CREATE INDEX "idx_learning_assistant_runs_conversation_created" ON "learning_assistant_runs" USING btree ("conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_learning_assistant_runs_owner_status_created" ON "learning_assistant_runs" USING btree ("owner_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_learning_experience_memories_owner_updated" ON "learning_experience_memories" USING btree ("owner_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_learning_experience_memories_owner_knowledge" ON "learning_experience_memories" USING btree ("owner_id","knowledge_point");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_model_connections_owner_default" ON "user_model_connections" USING btree ("owner_id") WHERE "user_model_connections"."is_default";--> statement-breakpoint
ALTER TABLE "learning_assistant_conversations" ADD CONSTRAINT "learning_assistant_conversations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_assistant_conversations" ADD CONSTRAINT "learning_assistant_conversations_goal_id_learning_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."learning_goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_assistant_conversations" ADD CONSTRAINT "learning_assistant_conversations_source_assessment_answer_id_assessment_answers_id_fk" FOREIGN KEY ("source_assessment_answer_id") REFERENCES "public"."assessment_answers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_assistant_messages" ADD CONSTRAINT "learning_assistant_messages_conversation_id_learning_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."learning_assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_assistant_runs" ADD CONSTRAINT "learning_assistant_runs_conversation_id_learning_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."learning_assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_assistant_runs" ADD CONSTRAINT "learning_assistant_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_assistant_runs" ADD CONSTRAINT "learning_assistant_runs_trigger_message_id_learning_assistant_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."learning_assistant_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_experience_memories" ADD CONSTRAINT "learning_experience_memories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_experience_memories" ADD CONSTRAINT "learning_experience_memories_conversation_id_learning_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."learning_assistant_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_experience_memories" ADD CONSTRAINT "learning_experience_memories_source_assessment_answer_id_assessment_answers_id_fk" FOREIGN KEY ("source_assessment_answer_id") REFERENCES "public"."assessment_answers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_experience_memories" ADD CONSTRAINT "learning_experience_memories_source_run_id_learning_assistant_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."learning_assistant_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

