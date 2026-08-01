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
