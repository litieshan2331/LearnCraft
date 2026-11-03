CREATE TABLE "agent"."human_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"thread_id" varchar(255) NOT NULL,
	"schema_version" varchar(50) NOT NULL,
	"graph_version" varchar(100) NOT NULL,
	"questions_json" jsonb NOT NULL,
	"answers_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'waiting' NOT NULL,
	"idempotency_key" varchar(255),
	"expires_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "human_reviews_agent_run_id_unique" UNIQUE("agent_run_id"),
	CONSTRAINT "uq_human_reviews_run_idempotency" UNIQUE("agent_run_id","idempotency_key"),
	CONSTRAINT "ck_human_reviews_status" CHECK ("agent"."human_reviews"."status" in ('waiting', 'submitted', 'expired', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "agent"."agent_runs" DROP CONSTRAINT "ck_agent_runs_status";--> statement-breakpoint
ALTER TABLE "agent"."human_reviews" ADD CONSTRAINT "human_reviews_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "agent"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent"."human_reviews" ADD CONSTRAINT "human_reviews_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent"."human_reviews" ADD CONSTRAINT "human_reviews_goal_id_learning_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."learning_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_human_reviews_owner_status_expires" ON "agent"."human_reviews" USING btree ("owner_id","status","expires_at");--> statement-breakpoint
ALTER TABLE "agent"."agent_runs" ADD CONSTRAINT "ck_agent_runs_status" CHECK ("agent"."agent_runs"."status" in ('queued', 'running', 'waiting_for_human', 'succeeded', 'failed', 'cancelled', 'expired'));