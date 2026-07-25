/**
 * Identity 限界上下文的 Drizzle 表定义。
 *
 * 导出：
 * - users：用户身份与 Argon2id 密码哈希。
 * - authSessions：仅保存不透明 Session 原始 Token 的 SHA-256 哈希。
 */

import { check, index, pgTable, uuid, char, text, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import {
  citext,
  createdAtColumn,
  defaultNowTimestampColumn,
  nullableTimestampColumn,
  requiredTimestampColumn,
  updatedAtColumn,
} from "./_common";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: citext("email").notNull().unique(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  passwordHash: text("password_hash").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  lastLoginAt: nullableTimestampColumn("last_login_at"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  check(
    "ck_users_status",
    sql`${table.status} in ('active', 'suspended', 'pending_deletion')`,
  ),
]);

export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: requiredTimestampColumn("expires_at"),
  lastSeenAt: defaultNowTimestampColumn("last_seen_at"),
  revokedAt: nullableTimestampColumn("revoked_at"),
  ipHash: char("ip_hash", { length: 64 }),
  userAgent: varchar("user_agent", { length: 500 }),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  check("ck_auth_sessions_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
  index("idx_auth_sessions_user_active")
    .on(table.userId, table.expiresAt.desc())
    .where(sql`${table.revokedAt} is null`),
  index("idx_auth_sessions_cleanup")
    .on(table.expiresAt)
    .where(sql`${table.revokedAt} is null`),
]);
