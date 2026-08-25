-- LearnCraft 节点后测与源内容绑定增量迁移。
-- 新增 posttest_generate 类型、source_card_content_id，并将 post_test 约束到 plan_node。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."assessments" WHERE "kind" = 'post_test' AND "plan_node_id" IS NULL) THEN
    RAISE EXCEPTION '存在旧 plan_id 语义的 post_test 记录，请先人工补齐 plan_node_id/source_card_content_id 后再迁移。';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "agent"."agent_runs" DROP CONSTRAINT "ck_agent_runs_type";--> statement-breakpoint
ALTER TABLE "assessments" DROP CONSTRAINT "ck_assessment_scope";--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "source_card_content_id" uuid;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_source_card_content_id_card_contents_id_fk" FOREIGN KEY ("source_card_content_id") REFERENCES "public"."card_contents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent"."agent_runs" ADD CONSTRAINT "ck_agent_runs_type" CHECK ("agent"."agent_runs"."run_type" in (
      'assessment_generate', 'plan_generate',
      'card_content_generate', 'posttest_generate', 'adaptation'
    ));--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "ck_assessment_scope" CHECK ((
      ("assessments"."kind" = 'diagnostic'
      and "assessments"."plan_id" is null
      and "assessments"."plan_node_id" is null
      and "assessments"."source_card_content_id" is null
    ) or (
      "assessments"."kind" = 'post_test'
      and "assessments"."plan_id" is null
      and "assessments"."plan_node_id" is not null
      and "assessments"."source_card_content_id" is not null
    ) or (
      "assessments"."kind" = 'card_quiz'
      and "assessments"."plan_node_id" is not null
      and "assessments"."source_card_content_id" is null
    )));