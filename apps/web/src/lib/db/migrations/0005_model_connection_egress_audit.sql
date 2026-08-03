CREATE TABLE "model_connection_egress_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"model_connection_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"host" varchar(253),
	"port" integer,
	"decision" varchar(20) NOT NULL,
	"reason_code" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_model_connection_egress_audits_decision" CHECK ("model_connection_egress_audits"."decision" in ('allowed', 'blocked', 'request_failed')),
	CONSTRAINT "ck_model_connection_egress_audits_port" CHECK ("model_connection_egress_audits"."port" is null or "model_connection_egress_audits"."port" between 1 and 65535),
	CONSTRAINT "ck_model_connection_egress_audits_reason_code" CHECK (length(btrim("model_connection_egress_audits"."reason_code")) > 0),
	CONSTRAINT "ck_model_connection_egress_audits_expiry" CHECK ("model_connection_egress_audits"."expires_at" > "model_connection_egress_audits"."created_at")
);
--> statement-breakpoint
ALTER TABLE "model_connection_egress_audits" ADD CONSTRAINT "model_connection_egress_audits_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_model_connection_egress_audits_cleanup" ON "model_connection_egress_audits" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_model_connection_egress_audits_connection_occurred" ON "model_connection_egress_audits" USING btree ("model_connection_id","created_at" DESC NULLS LAST);