-- LearnCraft 用户自带模型连接迁移：加密保存 OpenAI-compatible 凭据，并为目标与 AgentRun 记录选择快照。
-- P0 允许自定义 Base URL；SSRF 主机、DNS 与重定向防护将在 P1 的受控出网适配器中补充。
CREATE TABLE "user_model_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"protocol" varchar(40) DEFAULT 'openai_compatible' NOT NULL,
	"base_url" text NOT NULL,
	"default_model_id" varchar(255) NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"api_key_iv" text NOT NULL,
	"api_key_auth_tag" text NOT NULL,
	"encryption_key_version" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_user_model_connections_owner_name" UNIQUE("owner_id","display_name"),
	CONSTRAINT "ck_user_model_connections_protocol" CHECK ("user_model_connections"."protocol" = 'openai_compatible'),
	CONSTRAINT "ck_user_model_connections_status" CHECK ("user_model_connections"."status" in ('active', 'invalid', 'revoked')),
	CONSTRAINT "ck_user_model_connections_base_url" CHECK (length(btrim("user_model_connections"."base_url")) > 0),
	CONSTRAINT "ck_user_model_connections_default_model" CHECK (length(btrim("user_model_connections"."default_model_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "agent"."agent_runs" ADD COLUMN "model_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "agent"."agent_runs" ADD COLUMN "requested_model_id" varchar(255);--> statement-breakpoint
ALTER TABLE "learning_goals" ADD COLUMN "model_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "user_model_connections" ADD CONSTRAINT "user_model_connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_model_connections_owner_default" ON "user_model_connections" USING btree ("owner_id") WHERE "user_model_connections"."is_default";--> statement-breakpoint
CREATE INDEX "idx_user_model_connections_owner_status" ON "user_model_connections" USING btree ("owner_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "agent"."agent_runs" ADD CONSTRAINT "agent_runs_model_connection_id_user_model_connections_id_fk" FOREIGN KEY ("model_connection_id") REFERENCES "public"."user_model_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_goals" ADD CONSTRAINT "learning_goals_model_connection_id_user_model_connections_id_fk" FOREIGN KEY ("model_connection_id") REFERENCES "public"."user_model_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER trg_user_model_connections_touch_updated_at BEFORE UPDATE ON public.user_model_connections FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
