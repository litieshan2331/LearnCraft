/**
 * 跨限界上下文的平台基础设施 Drizzle 表定义。
 *
 * 导出：
 * - outboxEvents：事务内可靠投递的事件记录。
 * - idempotencyKeys：用户 API 幂等键的请求与结果快照。
 */

import { sql } from "drizzle-orm";
import {
  char,
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
  defaultNowTimestampColumn,
  nullableTimestampColumn,
  requiredTimestampColumn,
  updatedAtColumn,
} from "./_common";

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  aggregateType: varchar("aggregate_type", { length: 80 }).notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  eventType: varchar("event_type", { length: 120 }).notNull(),
  eventVersion: integer("event_version").notNull().default(1),
  payloadJson: jsonb("payload_json").notNull(),
  traceId: varchar("trace_id", { length: 128 }),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  availableAt: defaultNowTimestampColumn("available_at"),
  lockedBy: varchar("locked_by", { length: 100 }),
  lockedAt: nullableTimestampColumn("locked_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  publishedAt: nullableTimestampColumn("published_at"),
  createdAt: createdAtColumn(),
}, (table) => [
  check(
    "ck_outbox_events_status",
    sql`${table.status} in ('pending', 'processing', 'published', 'failed', 'dead')`,
  ),
  check("ck_outbox_events_attempt_count", sql`${table.attemptCount} >= 0`),
  index("idx_outbox_events_poll")
    .on(table.status, table.availableAt, table.createdAt)
    .where(sql`${table.status} in ('pending', 'failed')`),
]);

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorKey: varchar("actor_key", { length: 300 }).notNull(),
  scope: varchar("scope", { length: 120 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  requestHash: char("request_hash", { length: 64 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("processing"),
  responseStatus: integer("response_status"),
  resourceType: varchar("resource_type", { length: 80 }),
  resourceId: uuid("resource_id"),
  responseJson: jsonb("response_json").notNull().default({}),
  expiresAt: requiredTimestampColumn("expires_at"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("uq_idempotency_actor_scope_key").on(
    table.actorKey,
    table.scope,
    table.idempotencyKey,
  ),
  check(
    "ck_idempotency_keys_status",
    sql`${table.status} in ('processing', 'succeeded', 'failed')`,
  ),
  index("idx_idempotency_keys_expiry").on(table.expiresAt),
]);
