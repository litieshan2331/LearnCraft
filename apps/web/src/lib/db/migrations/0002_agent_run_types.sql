-- LearnCraft AgentRun 类型迁移：移除 P0 不再使用的简答评分与卡片随堂题任务类型。
-- 前测与路线后测均使用 assessment_generate；仅收敛检查约束，不改写任何任务数据。
ALTER TABLE "agent"."agent_runs" DROP CONSTRAINT "ck_agent_runs_type";--> statement-breakpoint
ALTER TABLE "agent"."agent_runs" ADD CONSTRAINT "ck_agent_runs_type" CHECK ("agent"."agent_runs"."run_type" in (
      'assessment_generate', 'plan_generate',
      'card_content_generate', 'adaptation'
    ));
