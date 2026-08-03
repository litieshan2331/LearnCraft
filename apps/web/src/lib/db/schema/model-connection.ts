/**
 * 用户模型连接限界上下文的 Drizzle 表定义。
 *
 * 导出：
 * - userModelConnections：用户自带 OpenAI-compatible API 凭据、默认模型与连接状态。
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import {
  createdAtColumn,
  nullableTimestampColumn,
  requiredTimestampColumn,
  updatedAtColumn,
} from "./_common";
import { users } from "./identity";

export const userModelConnections = pgTable("user_model_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: varchar("display_name", { length: 80 }).notNull(),
  protocol: varchar("protocol", { length: 40 }).notNull().default("openai_compatible"),
  baseUrl: text("base_url").notNull(),
  defaultModelId: varchar("default_model_id", { length: 255 }).notNull(),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  apiKeyIv: text("api_key_iv").notNull(),
  apiKeyAuthTag: text("api_key_auth_tag").notNull(),
  encryptionKeyVersion: varchar("encryption_key_version", { length: 50 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  isDefault: boolean("is_default").notNull().default(false),
  lastVerifiedAt: nullableTimestampColumn("last_verified_at"),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("uq_user_model_connections_owner_name").on(table.ownerId, table.displayName),
  check(
    "ck_user_model_connections_protocol",
    sql`${table.protocol} = 'openai_compatible'`,
  ),
  check(
    "ck_user_model_connections_status",
    sql`${table.status} in ('active', 'invalid', 'revoked')`,
  ),
  check(
    "ck_user_model_connections_base_url",
    sql`length(btrim(${table.baseUrl})) > 0`,
  ),
  check(
    "ck_user_model_connections_default_model",
    sql`length(btrim(${table.defaultModelId})) > 0`,
  ),
  uniqueIndex("uq_user_model_connections_owner_default")
    .on(table.ownerId)
    .where(sql`${table.isDefault}`),
  index("idx_user_model_connections_owner_status").on(
    table.ownerId,
    table.status,
    table.updatedAt.desc(),
  ),
]);

/**
 * 记录模型 Provider 的安全出网决策；不保存 API Key、提示词、响应正文或 DNS IP。
 * 删除模型连接后仍保留 30 天内的安全审计痕迹，因此 modelConnectionId 不设置外键。
 */
export const modelConnectionEgressAudits = pgTable("model_connection_egress_audits", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  modelConnectionId: uuid("model_connection_id").notNull(),
  agentRunId: uuid("agent_run_id"),
  host: varchar("host", { length: 253 }),
  port: integer("port"),
  decision: varchar("decision", { length: 20 }).notNull(),
  reasonCode: varchar("reason_code", { length: 100 }).notNull(),
  occurredAt: createdAtColumn(),
  expiresAt: requiredTimestampColumn("expires_at"),
}, (table) => [
  check(
    "ck_model_connection_egress_audits_decision",
    sql`${table.decision} in ('allowed', 'blocked', 'request_failed')`,
  ),
  check(
    "ck_model_connection_egress_audits_port",
    sql`${table.port} is null or ${table.port} between 1 and 65535`,
  ),
  check(
    "ck_model_connection_egress_audits_reason_code",
    sql`length(btrim(${table.reasonCode})) > 0`,
  ),
  check(
    "ck_model_connection_egress_audits_expiry",
    sql`${table.expiresAt} > ${table.occurredAt}`,
  ),
  index("idx_model_connection_egress_audits_cleanup").on(table.expiresAt),
  index("idx_model_connection_egress_audits_connection_occurred")
    .on(table.modelConnectionId, table.occurredAt.desc()),
]);
