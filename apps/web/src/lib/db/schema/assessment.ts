/**
 * Assessment 限界上下文的 Drizzle 表定义。
 *
 * 导出：
 * - assessments、assessmentItems：前测、路线后测与卡片测验的配置及单选题评分合同。
 * - assessmentAttempts、assessmentAnswers：用户作答与确定性评分结果。
 */

import { sql } from "drizzle-orm";
import {
  check,
  boolean,
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
import { learningPlans, planNodes } from "./planning";
import { learningGoals } from "./profile";
import { users } from "./identity";

export const assessments = pgTable("assessments", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  goalId: uuid("goal_id")
    .notNull()
    .references(() => learningGoals.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").references(() => learningPlans.id, { onDelete: "cascade" }),
  planNodeId: uuid("plan_node_id").references(() => planNodes.id, {
    onDelete: "cascade",
  }),
  kind: varchar("kind", { length: 30 }).notNull(),
  requestedQuestionCount: integer("requested_question_count"),
  difficulty: varchar("difficulty", { length: 20 }).notNull().default("normal"),
  version: integer("version").notNull().default(1),
  status: varchar("status", { length: 30 }).notNull().default("generating"),
  schemaVersion: varchar("schema_version", { length: 50 }).notNull(),
  generationMetadata: jsonb("generation_metadata").notNull().default({}),
  totalScore: numeric("total_score", { precision: 8, scale: 2 }),
  maxScore: numeric("max_score", { precision: 8, scale: 2 }),
  scorePercent: numeric("score_percent", { precision: 5, scale: 2 }),
  masterySummary: jsonb("mastery_summary").notNull().default({}),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  check("ck_assessments_version", sql`${table.version} >= 1`),
  check("ck_assessments_kind", sql`${table.kind} in ('diagnostic', 'post_test', 'card_quiz')`),
  check(
    "ck_assessments_difficulty",
    sql`${table.difficulty} in ('normal', 'hard')`,
  ),
  check(
    "ck_assessments_question_count",
    sql`(
      (${table.kind} = 'diagnostic' and ${table.requestedQuestionCount} between 10 and 20)
      or (${table.kind} = 'post_test' and ${table.requestedQuestionCount} between 5 and 10)
      or (${table.kind} = 'card_quiz' and ${table.requestedQuestionCount} is null)
    )`,
  ),
  check(
    "ck_assessments_status",
    sql`${table.status} in (
      'generating', 'ready', 'in_progress', 'submitted', 'grading', 'graded', 'failed', 'archived'
    )`,
  ),
  check(
    "ck_assessments_score_percent",
    sql`${table.scorePercent} is null or ${table.scorePercent} between 0 and 100`,
  ),
  check(
    "ck_assessment_scope",
    sql`(
      ${table.kind} = 'diagnostic'
      and ${table.planId} is null
      and ${table.planNodeId} is null
    ) or (
      ${table.kind} = 'post_test'
      and ${table.planId} is not null
      and ${table.planNodeId} is null
    ) or (
      ${table.kind} = 'card_quiz' and ${table.planNodeId} is not null
    )`,
  ),
  index("idx_assessments_owner_goal_kind").on(
    table.ownerId,
    table.goalId,
    table.kind,
    table.createdAt.desc(),
  ),
]);

export const assessmentItems = pgTable("assessment_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  assessmentId: uuid("assessment_id")
    .notNull()
    .references(() => assessments.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  itemType: varchar("item_type", { length: 30 }).notNull(),
  prompt: text("prompt").notNull(),
  optionsJson: jsonb("options_json").notNull().default([]),
  answerKeyJson: jsonb("answer_key_json").notNull(),
  gradingMode: varchar("grading_mode", { length: 30 }).notNull(),
  rubricJson: jsonb("rubric_json").notNull().default({}),
  explanation: text("explanation").notNull(),
  skillTags: text("skill_tags").array().notNull().default(sql`'{}'::text[]`),
  maxScore: numeric("max_score", { precision: 8, scale: 2 }).notNull(),
  schemaVersion: varchar("schema_version", { length: 50 }).notNull(),
  createdAt: createdAtColumn(),
}, (table) => [
  unique("uq_assessment_items_ordinal").on(table.assessmentId, table.ordinal),
  check("ck_assessment_items_ordinal", sql`${table.ordinal} >= 1`),
  check(
    "ck_assessment_items_type",
    sql`${table.itemType} = 'single_choice'`,
  ),
  check(
    "ck_assessment_items_grading_mode_value",
    sql`${table.gradingMode} = 'deterministic'`,
  ),
  check("ck_assessment_items_max_score", sql`${table.maxScore} > 0`),
  check(
    "ck_assessment_item_grading_mode",
    sql`${table.itemType} = 'single_choice'
      and ${table.gradingMode} = 'deterministic'
      and jsonb_typeof(${table.optionsJson}) = 'array'
      and jsonb_array_length(${table.optionsJson}) >= 2`,
  ),
]);

export const assessmentAttempts = pgTable("assessment_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  assessmentId: uuid("assessment_id")
    .notNull()
    .references(() => assessments.id, { onDelete: "cascade" }),
  attemptNo: integer("attempt_no").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("in_progress"),
  totalScore: numeric("total_score", { precision: 8, scale: 2 }),
  maxScore: numeric("max_score", { precision: 8, scale: 2 }),
  scorePercent: numeric("score_percent", { precision: 5, scale: 2 }),
  masterySummary: jsonb("mastery_summary").notNull().default({}),
  gradingVersion: varchar("grading_version", { length: 50 }),
  startedAt: defaultNowTimestampColumn("started_at"),
  submittedAt: nullableTimestampColumn("submitted_at"),
  gradedAt: nullableTimestampColumn("graded_at"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("uq_assessment_attempt_no").on(
    table.assessmentId,
    table.ownerId,
    table.attemptNo,
  ),
  check("ck_assessment_attempts_no", sql`${table.attemptNo} >= 1`),
  check(
    "ck_assessment_attempts_status",
    sql`${table.status} in (
      'in_progress', 'submitted', 'grading', 'graded', 'invalid', 'grading_failed'
    )`,
  ),
  check(
    "ck_assessment_attempts_score_percent",
    sql`${table.scorePercent} is null or ${table.scorePercent} between 0 and 100`,
  ),
  index("idx_assessment_attempts_owner_assessment").on(
    table.ownerId,
    table.assessmentId,
    table.attemptNo.desc(),
  ),
]);

export const assessmentAnswers = pgTable("assessment_answers", {
  id: uuid("id").defaultRandom().primaryKey(),
  attemptId: uuid("attempt_id")
    .notNull()
    .references(() => assessmentAttempts.id, { onDelete: "cascade" }),
  assessmentItemId: uuid("assessment_item_id")
    .notNull()
    .references(() => assessmentItems.id, { onDelete: "restrict" }),
  answerJson: jsonb("answer_json").notNull(),
  isCorrect: boolean("is_correct"),
  score: numeric("score", { precision: 8, scale: 2 }),
  feedback: text("feedback"),
  weaknessTags: text("weakness_tags").array().notNull().default(sql`'{}'::text[]`),
  gradingMetadataJson: jsonb("grading_metadata_json").notNull().default({}),
  gradedAt: nullableTimestampColumn("graded_at"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("uq_assessment_answer_item").on(table.attemptId, table.assessmentItemId),
]);
