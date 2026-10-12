CREATE TABLE "agent"."learning_assistant_trace_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence_no" integer NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"span_id" uuid NOT NULL,
	"parent_span_id" uuid,
	"agent_name" varchar(40) NOT NULL,
	"turn_no" integer,
	"attempt_no" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"input_tokens" integer,
	"output_tokens" integer,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_learning_assistant_trace_sequence" UNIQUE("run_id","sequence_no"),
	CONSTRAINT "ck_learning_assistant_trace_sequence" CHECK ("agent"."learning_assistant_trace_events"."sequence_no" >= 1),
	CONSTRAINT "ck_learning_assistant_trace_actor" CHECK ("agent"."learning_assistant_trace_events"."agent_name" in ('main', 'error_attribution', 'socratic_tutor')),
	CONSTRAINT "ck_learning_assistant_trace_input_tokens" CHECK ("agent"."learning_assistant_trace_events"."input_tokens" is null or "agent"."learning_assistant_trace_events"."input_tokens" >= 0),
	CONSTRAINT "ck_learning_assistant_trace_output_tokens" CHECK ("agent"."learning_assistant_trace_events"."output_tokens" is null or "agent"."learning_assistant_trace_events"."output_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent"."learning_assistant_trace_events" ADD CONSTRAINT "learning_assistant_trace_events_run_id_learning_assistant_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."learning_assistant_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_learning_assistant_trace_span" ON "agent"."learning_assistant_trace_events" USING btree ("run_id","span_id");--> statement-breakpoint
CREATE INDEX "idx_learning_assistant_trace_parent" ON "agent"."learning_assistant_trace_events" USING btree ("run_id","parent_span_id");