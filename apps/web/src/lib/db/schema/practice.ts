/**
 * Practice 限界上下文的 Drizzle 表定义。
 *
 * 导出：
 * - codeRuns：受限 Python Runner 的请求、输出、资源消耗与幂等结果。
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import {
  createdAtColumn,
  nullableTimestampColumn,
  updatedAtColumn,
} from "./_common";
import { cardContents } from "./content";
import { planNodes } from "./planning";
import { learningGoals } from "./profile";
import { users } from "./identity";

export const codeRuns = pgTable("code_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  goalId: uuid("goal_id")
    .notNull()
    .references(() => learningGoals.id, { onDelete: "cascade" }),
  planNodeId: uuid("plan_node_id")
    .notNull()
    .references(() => planNodes.id, { onDelete: "cascade" }),
  cardContentId: uuid("card_content_id").references(() => cardContents.id, {
    onDelete: "set null",
  }),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  runnerJobId: varchar("runner_job_id", { length: 255 }),
  runtime: varchar("runtime", { length: 50 }).notNull().default("python-3.11"),
  status: varchar("status", { length: 20 }).notNull().default("queued"),
  sourceCode: text("source_code").notNull(),
  stdinJson: jsonb("stdin_json").notNull().default({}),
  stdout: text("stdout"),
  stderr: text("stderr"),
  exitCode: integer("exit_code"),
  testSummary: jsonb("test_summary").notNull().default({}),
  resourceUsage: jsonb("resource_usage").notNull().default({}),
  errorCode: varchar("error_code", { length: 100 }),
  startedAt: nullableTimestampColumn("started_at"),
  finishedAt: nullableTimestampColumn("finished_at"),
  expiresAt: nullableTimestampColumn("expires_at"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("uq_code_runs_owner_idempotency").on(table.ownerId, table.idempotencyKey),
  check(
    "ck_code_runs_status",
    sql`${table.status} in (
      'queued', 'running', 'succeeded', 'failed', 'timeout', 'rejected', 'cancelled'
    )`,
  ),
  index("idx_code_runs_owner_node_created").on(
    table.ownerId,
    table.planNodeId,
    table.createdAt.desc(),
  ),
]);
