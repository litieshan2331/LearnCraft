/**
 * 学习助手对话限界上下文的 Drizzle 表定义。
 *
 * 调用顺序：Route/应用服务创建 learningAssistantConversations → 持久化
 * learningAssistantMessages → 创建并更新 learningAssistantRuns → 在错误被验证或修复后
 * 写入 learningExperienceMemories。本文件只定义会话、消息、对话运行和学习经历记忆的数据库契约。
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import {
  createdAtColumn,
  defaultNowTimestampColumn,
  nullableTimestampColumn,
  updatedAtColumn,
} from "./_common";
import { assessmentAnswers } from "./assessment";
import { users } from "./identity";
import { learningGoals } from "./profile";

/** 学习助手的一次可恢复对话；goalId 允许为空，支持从错题本直接进入。 */
export const learningAssistantConversations = pgTable(
  "learning_assistant_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").references(() => learningGoals.id, {
      onDelete: "set null",
    }),
    sourceAssessmentAnswerId: uuid("source_assessment_answer_id").references(
      () => assessmentAnswers.id,
      { onDelete: "set null" },
    ),
    status: varchar("status", { length: 30 }).notNull().default("active"),
    stage: varchar("stage", { length: 40 }).notNull().default("new"),
    stateJson: jsonb("state_json").notNull().default({}),
    lastMessageAt: nullableTimestampColumn("last_message_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    check(
      "ck_learning_assistant_conversations_status",
      sql`${table.status} in ('active', 'completed', 'archived')`,
    ),
    check(
      "ck_learning_assistant_conversations_stage",
      sql`${table.stage} in (
        'new', 'context_loaded', 'diagnosing', 'waiting_for_user', 'hinting',
        'checking_repair', 'mastered', 'needs_more_practice', 'unresolved'
      )`,
    ),
    index("idx_learning_assistant_conversations_owner_updated").on(
      table.ownerId,
      table.updatedAt.desc(),
    ),
    index("idx_learning_assistant_conversations_source_answer").on(
      table.sourceAssessmentAnswerId,
    ),
  ],
);

/** 对话中的用户、助手和工具消息；消息永久落库，模型默认只读取最近 20 轮。 */
export const learningAssistantMessages = pgTable(
  "learning_assistant_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => learningAssistantConversations.id, { onDelete: "cascade" }),
    sequenceNo: integer("sequence_no").notNull(),
    turnNo: integer("turn_no").notNull(),
    role: varchar("role", { length: 20 }).notNull(),
    content: text("content"),
    toolName: varchar("tool_name", { length: 100 }),
    toolCallId: varchar("tool_call_id", { length: 150 }),
    toolInputJson: jsonb("tool_input_json").notNull().default({}),
    toolResultJson: jsonb("tool_result_json").notNull().default({}),
    metadataJson: jsonb("metadata_json").notNull().default({}),
    createdAt: createdAtColumn(),
  },
  (table) => [
    unique("uq_learning_assistant_messages_sequence").on(
      table.conversationId,
      table.sequenceNo,
    ),
    check(
      "ck_learning_assistant_messages_role",
      sql`${table.role} in ('user', 'assistant', 'tool')`,
    ),
    check("ck_learning_assistant_messages_sequence", sql`${table.sequenceNo} >= 1`),
    check("ck_learning_assistant_messages_turn", sql`${table.turnNo} >= 1`),
    index("idx_learning_assistant_messages_conversation_turn").on(
      table.conversationId,
      table.turnNo,
      table.sequenceNo,
    ),
  ],
);

/** 一次用户消息触发的对话执行；汇总模型、子 Agent、Skill、Tavily 和错误信息。 */
export const learningAssistantRuns = pgTable(
  "learning_assistant_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => learningAssistantConversations.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    triggerMessageId: uuid("trigger_message_id").references(
      () => learningAssistantMessages.id,
      { onDelete: "set null" },
    ),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("queued"),
    orchestrationVersion: varchar("orchestration_version", { length: 100 }).notNull(),
    modelId: varchar("model_id", { length: 255 }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    modelCallCount: integer("model_call_count").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    subAgentSummaryJson: jsonb("sub_agent_summary_json").notNull().default([]),
    skillSummaryJson: jsonb("skill_summary_json").notNull().default([]),
    tavilySummaryJson: jsonb("tavily_summary_json").notNull().default([]),
    inputSummaryJson: jsonb("input_summary_json").notNull().default({}),
    outputSummaryJson: jsonb("output_summary_json").notNull().default({}),
    errorCode: varchar("error_code", { length: 100 }),
    errorSummary: text("error_summary"),
    startedAt: nullableTimestampColumn("started_at"),
    finishedAt: nullableTimestampColumn("finished_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique("uq_learning_assistant_runs_idempotency").on(
      table.conversationId,
      table.idempotencyKey,
    ),
    check(
      "ck_learning_assistant_runs_status",
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check("ck_learning_assistant_runs_input_tokens", sql`${table.inputTokens} >= 0`),
    check("ck_learning_assistant_runs_output_tokens", sql`${table.outputTokens} >= 0`),
    check("ck_learning_assistant_runs_model_calls", sql`${table.modelCallCount} >= 0`),
    check("ck_learning_assistant_runs_tool_calls", sql`${table.toolCallCount} >= 0`),
    index("idx_learning_assistant_runs_conversation_created").on(
      table.conversationId,
      table.createdAt.desc(),
    ),
    index("idx_learning_assistant_runs_owner_status_created").on(
      table.ownerId,
      table.status,
      table.createdAt.desc(),
    ),
  ],
);

/** 经过证据验证的错因、干预结果和修复状态；不向用户提供直接编辑接口。 */
export const learningExperienceMemories = pgTable(
  "learning_experience_memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(
      () => learningAssistantConversations.id,
      { onDelete: "set null" },
    ),
    sourceAssessmentAnswerId: uuid("source_assessment_answer_id").references(
      () => assessmentAnswers.id,
      { onDelete: "set null" },
    ),
    sourceRunId: uuid("source_run_id").references(() => learningAssistantRuns.id, {
      onDelete: "set null",
    }),
    memoryType: varchar("memory_type", { length: 40 }).notNull(),
    knowledgePoint: varchar("knowledge_point", { length: 200 }),
    errorType: varchar("error_type", { length: 40 }),
    pattern: text("pattern"),
    evidenceJson: jsonb("evidence_json").notNull().default([]),
    interventionJson: jsonb("intervention_json").notNull().default({}),
    repairStatus: varchar("repair_status", { length: 30 }).notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    observedAt: defaultNowTimestampColumn("observed_at"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    check(
      "ck_learning_experience_memories_type",
      sql`${table.memoryType} in ('error_pattern', 'concept_gap', 'learning_preference', 'intervention_result')`,
    ),
    check(
      "ck_learning_experience_memories_repair_status",
      sql`${table.repairStatus} in ('unverified', 'improving', 'repaired', 'needs_more_practice', 'unresolved')`,
    ),
    check(
      "ck_learning_experience_memories_confidence",
      sql`${table.confidence} between 0 and 1`,
    ),
    index("idx_learning_experience_memories_owner_updated").on(
      table.ownerId,
      table.updatedAt.desc(),
    ),
    index("idx_learning_experience_memories_owner_knowledge").on(
      table.ownerId,
      table.knowledgePoint,
    ),
  ],
);
