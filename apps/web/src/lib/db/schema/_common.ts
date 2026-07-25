/**
 * LearnCraft Drizzle Schema 的公共列和 PostgreSQL 自定义类型。
 *
 * 导出：
 * - citext：映射 PostgreSQL citext 扩展类型。
 * - tsvector：映射 PostgreSQL 全文检索的 tsvector 类型。
 * - createdAtColumn、updatedAtColumn：创建带时区且具有默认值的审计时间列。
 * - requiredTimestampColumn、nullableTimestampColumn、defaultNowTimestampColumn：创建具名业务时间列。
 */

import { customType, timestamp } from "drizzle-orm/pg-core";

export const citext = customType<{
  data: string;
  driverData: string;
}>({
  dataType: () => "citext",
});

export const tsvector = customType<{
  data: string;
  driverData: string;
}>({
  dataType: () => "tsvector",
});

export function createdAtColumn() {
  return timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
}

export function updatedAtColumn() {
  return timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
}

export function requiredTimestampColumn(name: string) {
  return timestamp(name, { withTimezone: true }).notNull();
}

export function nullableTimestampColumn(name: string) {
  return timestamp(name, { withTimezone: true });
}

export function defaultNowTimestampColumn(name: string) {
  return timestamp(name, { withTimezone: true }).defaultNow().notNull();
}
