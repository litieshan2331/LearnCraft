/**
 * Planning 限界上下文的 Drizzle 表定义。
 *
 * 导出：
 * - learningPlans：目标的版本化学习路线。
 * - planNodes、planNodePrerequisites：路线节点及其有向前置依赖。
 * - adaptationEvents：规则驱动的路线调整审计记录。
 */

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import {
  createdAtColumn,
  nullableTimestampColumn,
  updatedAtColumn,
} from "./_common";
import { users } from "./identity";
import { learningGoals } from "./profile";

export const learningPlans = pgTable("learning_plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  goalId: uuid("goal_id")
    .notNull()
    .references(() => learningGoals.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  summary: text("summary"),
  status: varchar("status", { length: 30 }).notNull().default("generating"),
  schemaVersion: varchar("schema_version", { length: 50 }).notNull(),
  generationMetadata: jsonb("generation_metadata").notNull().default({}),
  generatedAt: nullableTimestampColumn("generated_at"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("uq_learning_plans_goal_version").on(table.goalId, table.version),
  check("ck_learning_plans_version", sql`${table.version} >= 1`),
  check(
    "ck_learning_plans_status",
    sql`${table.status} in ('generating', 'active', 'superseded', 'failed', 'archived')`,
  ),
  uniqueIndex("uq_learning_plans_one_active_goal")
    .on(table.goalId)
    .where(sql`${table.status} = 'active'`),
  index("idx_learning_plans_owner_goal").on(
    table.ownerId,
    table.goalId,
    table.version.desc(),
  ),
]);

export const planNodes = pgTable("plan_nodes", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  planId: uuid("plan_id")
    .notNull()
    .references(() => learningPlans.id, { onDelete: "cascade" }),
  parentNodeId: uuid("parent_node_id").references(
    (): AnyPgColumn => planNodes.id,
    { onDelete: "set null" },
  ),
  nodeKey: varchar("node_key", { length: 100 }).notNull(),
  ordinal: integer("ordinal").notNull(),
  phase: varchar("phase", { length: 20 }).notNull(),
  nodeKind: varchar("node_kind", { length: 20 }).notNull().default("core"),
  title: varchar("title", { length: 255 }).notNull(),
  learningObjective: text("learning_objective").notNull(),
  rationale: text("rationale"),
  difficulty: smallint("difficulty").notNull(),
  estimatedMinutes: integer("estimated_minutes").notNull(),
  completionCriteria: jsonb("completion_criteria").notNull().default({}),
  status: varchar("status", { length: 30 }).notNull().default("locked"),
  contentStatus: varchar("content_status", { length: 30 }).notNull().default("not_requested"),
  insertedReason: text("inserted_reason"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("uq_plan_nodes_key").on(table.planId, table.nodeKey),
  unique("uq_plan_nodes_ordinal").on(table.planId, table.ordinal),
  check("ck_plan_nodes_ordinal", sql`${table.ordinal} >= 1`),
  check("ck_plan_nodes_phase", sql`${table.phase} in ('concept', 'syntax', 'practice', 'debug')`),
  check("ck_plan_nodes_kind", sql`${table.nodeKind} in ('core', 'reinforcement', 'advanced')`),
  check("ck_plan_nodes_difficulty", sql`${table.difficulty} between 1 and 5`),
  check("ck_plan_nodes_estimated_minutes", sql`${table.estimatedMinutes} between 5 and 1440`),
  check(
    "ck_plan_nodes_status",
    sql`${table.status} in (
      'locked', 'available', 'in_progress', 'completed', 'needs_review', 'skipped'
    )`,
  ),
  check(
    "ck_plan_nodes_content_status",
    sql`${table.contentStatus} in ('not_requested', 'generating', 'ready', 'failed')`,
  ),
  index("idx_plan_nodes_owner_status").on(
    table.ownerId,
    table.status,
    table.updatedAt.desc(),
  ),
]);

export const planNodePrerequisites = pgTable("plan_node_prerequisites", {
  nodeId: uuid("node_id")
    .notNull()
    .references(() => planNodes.id, { onDelete: "cascade" }),
  prerequisiteNodeId: uuid("prerequisite_node_id")
    .notNull()
    .references(() => planNodes.id, { onDelete: "cascade" }),
  createdAt: createdAtColumn(),
}, (table) => [
  primaryKey({ columns: [table.nodeId, table.prerequisiteNodeId] }),
  check(
    "ck_plan_node_not_self_prerequisite",
    sql`${table.nodeId} <> ${table.prerequisiteNodeId}`,
  ),
  index("idx_plan_node_prerequisites_prerequisite").on(table.prerequisiteNodeId),
]);

export const adaptationEvents = pgTable("adaptation_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  planId: uuid("plan_id")
    .notNull()
    .references(() => learningPlans.id, { onDelete: "cascade" }),
  triggerNodeId: uuid("trigger_node_id")
    .notNull()
    .references(() => planNodes.id, { onDelete: "cascade" }),
  eventType: varchar("event_type", { length: 30 }).notNull(),
  policyVersion: varchar("policy_version", { length: 50 }).notNull(),
  evidenceJson: jsonb("evidence_json").notNull().default({}),
  resultJson: jsonb("result_json").notNull().default({}),
  createdAt: createdAtColumn(),
}, (table) => [
  check(
    "ck_adaptation_events_type",
    sql`${table.eventType} in (
      'unlock', 'recommend_review', 'insert_reinforcement', 'accelerate', 'skip'
    )`,
  ),
  index("idx_adaptation_events_plan_created").on(table.planId, table.createdAt.desc()),
]);
