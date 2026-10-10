/**
 * Drizzle Kit 数据库迁移配置。
 *
 * 常量：
 * - databaseUrl：供 drizzle-kit migrate 使用的 PostgreSQL 连接串；生成迁移时不会连接占位地址。
 */

import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

/** 按本地开发约定加载环境文件；已有进程环境变量保持优先级。 */
function loadProjectEnvFiles(): void {
  const configDirectory = dirname(fileURLToPath(import.meta.url));
  const envFiles = [
    resolve(configDirectory, "../../infra/.env"),
    resolve(configDirectory, "../../.env"),
  ];
  for (const envFile of envFiles) {
    if (existsSync(envFile)) {
      loadEnvFile(envFile);
    }
  }
}

loadProjectEnvFiles();

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
