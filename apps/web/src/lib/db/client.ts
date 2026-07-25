/**
 * LearnCraft Web 的 PostgreSQL/Drizzle 客户端工厂。
 *
 * 导出：
 * - getDatabase：懒加载并返回进程内共享的 Drizzle 数据库客户端。
 * - closeDatabasePool：关闭测试或脚本运行结束后的连接池。
 */

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

type LearnCraftDatabase = NodePgDatabase<typeof schema>;

let database: LearnCraftDatabase | undefined;
let databasePool: Pool | undefined;

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error("DATABASE_URL 未配置，无法创建 LearnCraft 数据库客户端。");
  }

  return databaseUrl;
}

export function getDatabase(): LearnCraftDatabase {
  if (database) {
    return database;
  }

  databasePool = new Pool({ connectionString: getDatabaseUrl() });
  database = drizzle({ client: databasePool, schema });
  return database;
}

export async function closeDatabasePool(): Promise<void> {
  await databasePool?.end();
  database = undefined;
  databasePool = undefined;
}
