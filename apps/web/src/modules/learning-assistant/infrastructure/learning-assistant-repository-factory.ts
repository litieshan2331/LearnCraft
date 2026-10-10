/**
 * 学习助手 Repository 的进程内装配入口。
 *
 * 调用顺序：API 或应用服务调用 getLearningAssistantRepository → 复用同一个 Drizzle
 * Repository 实例 → Repository 内部通过 getDatabase 使用共享连接池；关闭连接池仍由
 * lib/db/client 的 closeDatabasePool 统一负责。本文件不包含业务规则。
 */

import { DrizzleLearningAssistantRepository } from "./drizzle-learning-assistant-repository";

let repository: DrizzleLearningAssistantRepository | undefined;

/** 返回进程内共享的四合一 Repository，避免每个 Route 重复创建适配器。 */
export function getLearningAssistantRepository(): DrizzleLearningAssistantRepository {
  repository ??= new DrizzleLearningAssistantRepository();
  return repository;
}
