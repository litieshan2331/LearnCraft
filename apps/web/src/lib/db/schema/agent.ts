/**
 * Agent 编排基础设施的 Drizzle 表定义。
 *
 * 导出：
 * - agentSchema：PostgreSQL 中仅供 Agent 编排使用的 agent schema。
 * - agentRuns、agentRunEvents：可恢复、可审计的 Agent 长任务及事件序列。
 */

import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  unique,
  uuid,
  varchar,
  text,
} from "drizzle-orm/pg-core";

import {
  createdAtColumn,
  defaultNowTimestampColumn,
  nullableTimestampColumn,
  updatedAtColumn,
} from "./_common";
import { users } from "./identity";
import { userModelConnections } from "./model-connection";

export const agentSchema = pgSchema("agent");

export const agentRuns = agentSchema.table("agent_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  runType: varchar("run_type", { length: 40 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("queued"),
  targetType: varchar("target_type", { length: 50 }).notNull(),
  targetId: uuid("target_id").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  traceId: varchar("trace_id", { length: 128 }).notNull(),
  graphVersion: varchar("graph_version", { length: 100 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 100 }),
  inputSchemaVersion: varchar("input_schema_version", { length: 100 }).notNull(),
  outputSchemaVersion: varchar("output_schema_version", { length: 100 }),
  requestedModelProfile: varchar("requested_model_profile", { length: 100 }).notNull(),
  modelConnectionId: uuid("model_connection_id").references(() => userModelConnections.id, {
    onDelete: "set null",
  }),
  requestedModelId: varchar("requested_model_id", { length: 255 }),
  actualModelProfile: varchar("actual_model_profile", { length: 100 }),
  fallbackReason: varchar("fallback_reason", { length: 255 }),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 })
    .notNull()
    .default("0"),
  retryCount: integer("retry_count").notNull().default(0),
  inputSummaryJson: jsonb("input_summary_json").notNull().default({}),
  outputSummaryJson: jsonb("output_summary_json").notNull().default({}),
  errorCode: varchar("error_code", { length: 100 }),
  errorSummary: text("error_summary"),
  startedAt: nullableTimestampColumn("started_at"),
  finishedAt: nullableTimestampColumn("finished_at"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("uq_agent_runs_idempotency").on(
    table.ownerId,
    table.runType,
    table.idempotencyKey,
  ),
  check(
    "ck_agent_runs_type",
    sql`${table.runType} in (
      'assessment_generate', 'plan_generate',
      'card_content_generate', 'adaptation'
    )`,
  ),
  check(
    "ck_agent_runs_status",
    sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')`,
  ),
  check("ck_agent_runs_input_tokens", sql`${table.inputTokens} >= 0`),
  check("ck_agent_runs_output_tokens", sql`${table.outputTokens} >= 0`),
  check("ck_agent_runs_cost", sql`${table.estimatedCostUsd} >= 0`),
  check("ck_agent_runs_retry_count", sql`${table.retryCount} >= 0`),
  index("idx_agent_runs_owner_status_created").on(
    table.ownerId,
    table.status,
    table.createdAt.desc(),
  ),
  index("idx_agent_runs_target").on(
    table.targetType,
    table.targetId,
    table.createdAt.desc(),
  ),
]);

export const agentRunEvents = agentSchema.table("agent_run_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  agentRunId: uuid("agent_run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  sequenceNo: integer("sequence_no").notNull(),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  payloadJson: jsonb("payload_json").notNull().default({}),
  occurredAt: defaultNowTimestampColumn("occurred_at"),
}, (table) => [
  unique("uq_agent_run_events_sequence").on(table.agentRunId, table.sequenceNo),
  check("ck_agent_run_events_sequence", sql`${table.sequenceNo} >= 1`),
  index("idx_agent_run_events_run_sequence").on(table.agentRunId, table.sequenceNo),
]);
