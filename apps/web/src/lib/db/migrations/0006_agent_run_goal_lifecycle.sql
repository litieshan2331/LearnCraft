ALTER TABLE "agent"."agent_runs" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
UPDATE "agent"."agent_runs"
SET "goal_id" = "target_id"
WHERE "target_type" = 'learning_goal';--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "agent"."agent_runs" WHERE "goal_id" IS NULL) THEN
    RAISE EXCEPTION 'agent.agent_runs 中存在无法回填 goal_id 的历史任务，请先完成目标归属迁移。';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "agent"."agent_runs" ALTER COLUMN "goal_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent"."agent_runs" ADD CONSTRAINT "agent_runs_goal_id_learning_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."learning_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_runs_owner_goal_status_created" ON "agent"."agent_runs" USING btree ("owner_id","goal_id","status","created_at" DESC NULLS LAST);
