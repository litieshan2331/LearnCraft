-- LearnCraft 书籍章节式路线生成 Schema 增量迁移。
-- 移除 plan_nodes.phase，并为路线固化画像版本、输入快照和 node_brief。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."learning_plans")
     OR EXISTS (SELECT 1 FROM "public"."plan_nodes") THEN
    RAISE EXCEPTION '存在历史学习路线或节点，请先人工回填 profile_version、input_snapshot_json 和 node_brief 后再迁移。';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "plan_nodes" DROP CONSTRAINT "ck_plan_nodes_phase";--> statement-breakpoint
ALTER TABLE "plan_nodes" ALTER COLUMN "status" SET DEFAULT 'available';--> statement-breakpoint
ALTER TABLE "learning_plans" ADD COLUMN "profile_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_plans" ADD COLUMN "input_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_nodes" ADD COLUMN "node_brief" text NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_nodes" DROP COLUMN "phase";