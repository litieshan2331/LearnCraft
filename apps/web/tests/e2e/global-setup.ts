/**
 * 学习助手 E2E 环境隔离预检。
 *
 * 调用顺序：检查显式 Web、PostgreSQL、Redis 和假模型标记 → 阻止非隔离地址 → 允许 Playwright 启动测试。
 */

import type { FullConfig } from "@playwright/test";

const REQUIRED = [
  "LEARNING_ASSISTANT_E2E_WEB_URL",
  "LEARNING_ASSISTANT_E2E_TEST_DATABASE_URL",
  "LEARNING_ASSISTANT_E2E_TEST_REDIS_URL",
  "LEARNING_ASSISTANT_E2E_DISPATCHER_URL",
  "LEARNING_ASSISTANT_E2E_WORKER_URL",
  "LEARNING_ASSISTANT_E2E_TEST_USER_EMAIL",
  "LEARNING_ASSISTANT_E2E_TEST_USER_PASSWORD",
  "LEARNING_ASSISTANT_E2E_MODEL",
] as const;

export default async function globalSetup(_config: FullConfig): Promise<void> {
  void _config;
  const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `学习助手 E2E 已停止：必须显式设置 ${missing.join(", " )}。` +
      "测试不会读取 infra/.env、DATABASE_URL、REDIS_URL 或真实 Provider 配置。",
    );
  }

  const databaseUrl = new URL(process.env.LEARNING_ASSISTANT_E2E_TEST_DATABASE_URL!);
  const redisUrl = new URL(process.env.LEARNING_ASSISTANT_E2E_TEST_REDIS_URL!);
  const databaseName = databaseUrl.pathname.replace(/^\//, "").toLowerCase();
  const redisDatabase = Number(redisUrl.pathname.replace(/^\//, ""));
  if (!/(^|[_-])(test|e2e)([_-]|$)/.test(databaseName)) {
    throw new Error("学习助手 E2E 已停止：测试 PostgreSQL 数据库名必须包含 test 或 e2e。");
  }
  if (!Number.isInteger(redisDatabase) || redisDatabase < 1) {
    throw new Error("学习助手 E2E 已停止：测试 Redis 必须显式使用非 0 的数据库编号。");
  }

  const webUrl = new URL(process.env.LEARNING_ASSISTANT_E2E_WEB_URL!);
  if (webUrl.protocol !== "http:" && webUrl.protocol !== "https:") {
    throw new Error("学习助手 E2E 已停止：Web URL 必须使用 HTTP 或 HTTPS。");
  }
  for (const name of ["LEARNING_ASSISTANT_E2E_DISPATCHER_URL", "LEARNING_ASSISTANT_E2E_WORKER_URL"] as const) {
    const serviceUrl = new URL(process.env[name]!);
    if (serviceUrl.protocol !== "http:" && serviceUrl.protocol !== "https:") {
      throw new Error(`学习助手 E2E 已停止：${name} 必须使用 HTTP 或 HTTPS。`);
    }
  }
  if (process.env.LEARNING_ASSISTANT_E2E_MODEL !== "fake") {
    throw new Error("学习助手 E2E 已停止：必须设置 LEARNING_ASSISTANT_E2E_MODEL=fake，禁止真实 Provider。");
  }

  const dispatcherHealth = await readHealth(process.env.LEARNING_ASSISTANT_E2E_DISPATCHER_URL!);
  if (dispatcherHealth.service !== "agent-dispatcher-ts") {
    throw new Error("学习助手 E2E 已停止：Dispatcher 健康端点服务名不匹配。");
  }
  const workerHealth = await readHealth(process.env.LEARNING_ASSISTANT_E2E_WORKER_URL!);
  if (workerHealth.service !== "agent-worker-ts" || workerHealth.model_mode !== "fake") {
    throw new Error("学习助手 E2E 已停止：Worker 必须是报告 model_mode=fake 的专用测试装配。");
  }
}

/** 读取健康端点，只接受就绪的预期服务，不输出 URL 中可能包含的凭据。 */
async function readHealth(baseUrl: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(new URL("/health", baseUrl));
  } catch {
    throw new Error("学习助手 E2E 已停止：Dispatcher/Worker 健康端点不可访问。");
  }
  if (!response.ok) throw new Error("学习助手 E2E 已停止：Dispatcher/Worker 健康检查失败。");
  return await response.json() as Record<string, unknown>;
}
