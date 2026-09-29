CREATE TABLE "agent"."agent_trace_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"sequence_no" integer NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"turn_no" integer,
	"step_no" integer,
	"attempt_no" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"input_tokens" integer,
	"output_tokens" integer,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_agent_trace_events_sequence" UNIQUE("agent_run_id","sequence_no"),
	CONSTRAINT "ck_agent_trace_events_sequence" CHECK ("agent"."agent_trace_events"."sequence_no" >= 1),
	CONSTRAINT "ck_agent_trace_events_turn" CHECK ("agent"."agent_trace_events"."turn_no" is null or "agent"."agent_trace_events"."turn_no" >= 1),
	CONSTRAINT "ck_agent_trace_events_step" CHECK ("agent"."agent_trace_events"."step_no" is null or "agent"."agent_trace_events"."step_no" >= 1),
	CONSTRAINT "ck_agent_trace_events_attempt" CHECK ("agent"."agent_trace_events"."attempt_no" is null or "agent"."agent_trace_events"."attempt_no" >= 1),
	CONSTRAINT "ck_agent_trace_events_input_tokens" CHECK ("agent"."agent_trace_events"."input_tokens" is null or "agent"."agent_trace_events"."input_tokens" >= 0),
	CONSTRAINT "ck_agent_trace_events_output_tokens" CHECK ("agent"."agent_trace_events"."output_tokens" is null or "agent"."agent_trace_events"."output_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent"."agent_trace_events" ADD CONSTRAINT "agent_trace_events_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "agent"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_trace_events_run_sequence" ON "agent"."agent_trace_events" USING btree ("agent_run_id","sequence_no");