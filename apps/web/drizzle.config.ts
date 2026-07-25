/**
 * Drizzle Kit 数据库迁移配置。
 *
 * 常量：
 * - databaseUrl：供 drizzle-kit migrate 使用的 PostgreSQL 连接串；生成迁移时不会连接占位地址。
 */

import { defineConfig } from "drizzle-kit";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://drizzle:drizzle@127.0.0.1:5432/drizzle";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema/index.ts",
  out: "./src/lib/db/migrations",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
