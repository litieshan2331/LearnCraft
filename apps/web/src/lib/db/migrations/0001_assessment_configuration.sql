-- LearnCraft 测验配置迁移：移除简答题与 AI rubric 约束，新增前测/路线后测题量、难度和范围校验。
-- 此迁移不删除旧列 rubric_json；新写入的题目仅允许确定性单选题，历史列留待后续数据保留策略统一处理。
ALTER TABLE "assessment_items" DROP CONSTRAINT "ck_assessment_items_type";--> statement-breakpoint
ALTER TABLE "assessment_items" DROP CONSTRAINT "ck_assessment_items_grading_mode_value";--> statement-breakpoint
ALTER TABLE "assessment_items" DROP CONSTRAINT "ck_assessment_item_grading_mode";--> statement-breakpoint
ALTER TABLE "assessments" DROP CONSTRAINT "ck_assessments_kind";--> statement-breakpoint
ALTER TABLE "assessments" DROP CONSTRAINT "ck_assessment_scope";--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "requested_question_count" integer;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "difficulty" varchar(20) DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "ck_assessment_items_type" CHECK ("assessment_items"."item_type" = 'single_choice');--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "ck_assessment_items_grading_mode_value" CHECK ("assessment_items"."grading_mode" = 'deterministic');--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "ck_assessment_item_grading_mode" CHECK ("assessment_items"."item_type" = 'single_choice'
      and "assessment_items"."grading_mode" = 'deterministic'
      and jsonb_typeof("assessment_items"."options_json") = 'array'
      and jsonb_array_length("assessment_items"."options_json") >= 2);--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "ck_assessments_difficulty" CHECK ("assessments"."difficulty" in ('normal', 'hard'));--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "ck_assessments_question_count" CHECK ((
      ("assessments"."kind" = 'diagnostic' and "assessments"."requested_question_count" between 10 and 20)
      or ("assessments"."kind" = 'post_test' and "assessments"."requested_question_count" between 5 and 10)
      or ("assessments"."kind" = 'card_quiz' and "assessments"."requested_question_count" is null)
    ));--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "ck_assessments_kind" CHECK ("assessments"."kind" in ('diagnostic', 'post_test', 'card_quiz'));--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "ck_assessment_scope" CHECK ((
      "assessments"."kind" = 'diagnostic'
      and "assessments"."plan_id" is null
      and "assessments"."plan_node_id" is null
    ) or (
      "assessments"."kind" = 'post_test'
      and "assessments"."plan_id" is not null
      and "assessments"."plan_node_id" is null
    ) or (
      "assessments"."kind" = 'card_quiz' and "assessments"."plan_node_id" is not null
    ));
