/**
 * Profile 限界上下文的 Drizzle 表定义。
 *
 * 导出：
 * - learnerProfiles：学习者画像及偏好版本。
 * - learningGoals：仅支持 Python 3.11 基础主题的学习目标。
 */

import { check, index, integer, jsonb, pgTable, uuid, varchar, date, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { createdAtColumn, updatedAtColumn } from "./_common";
import { users } from "./identity";
import { userModelConnections } from "./model-connection";

export const learnerProfiles = pgTable("learner_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  currentLevel: varchar("current_level", { length: 20 }).notNull(),
  primaryLanguage: varchar("primary_language", { length: 20 }).notNull().default("zh-CN"),
  weeklyMinutes: integer("weekly_minutes").notNull(),
  operatingSystem: varchar("operating_system", { length: 30 }),
  backgroundSummary: text("background_summary"),
  preferencesJson: jsonb("preferences_json").notNull().default({}),
  profileVersion: integer("profile_version").notNull().default(1),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  check(
    "ck_learner_profiles_current_level",
    sql`${table.currentLevel} in ('beginner', 'intermediate', 'advanced')`,
  ),
  check(
    "ck_learner_profiles_weekly_minutes",
    sql`${table.weeklyMinutes} between 30 and 10080`,
  ),
  check("ck_learner_profiles_version", sql`${table.profileVersion} >= 1`),
]);

export const learningGoals = pgTable("learning_goals", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  subjectKey: varchar("subject_key", { length: 80 }).notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  description: text("description").notNull(),
  desiredOutcome: text("desired_outcome").notNull(),
  targetDate: date("target_date", { mode: "string" }),
  weeklyMinutesOverride: integer("weekly_minutes_override"),
  modelConnectionId: uuid("model_connection_id").references(() => userModelConnections.id, {
    onDelete: "set null",
  }),
  profileVersion: integer("profile_version").notNull(),
  status: varchar("status", { length: 30 }).notNull().default("draft"),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  check("ck_learning_goals_subject", sql`${table.subjectKey} = 'python-311-basics'`),
  check("ck_learning_goals_profile_version", sql`${table.profileVersion} >= 1`),
  check(
    "ck_learning_goals_weekly_minutes_override",
    sql`${table.weeklyMinutesOverride} is null or ${table.weeklyMinutesOverride} between 30 and 10080`,
  ),
  check(
    "ck_learning_goals_status",
    sql`${table.status} in (
      'draft', 'assessment_pending', 'assessment_in_progress', 'planning',
      'active', 'completed', 'archived', 'failed'
    )`,
  ),
  index("idx_learning_goals_owner_status").on(
    table.ownerId,
    table.status,
    table.updatedAt.desc(),
  ),
]);
