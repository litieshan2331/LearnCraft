/**
 * 学习助手浏览器端到端测试配置。
 *
 * 调用顺序：Playwright 读取显式测试环境变量 → 执行隔离预检 → 连接已启动的 Web 并运行浏览器用例。
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: process.env.LEARNING_ASSISTANT_E2E_WEB_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: process.env.LEARNING_ASSISTANT_E2E_START_WEB === "1"
    ? { command: "pnpm dev", url: process.env.LEARNING_ASSISTANT_E2E_WEB_URL, reuseExistingServer: !process.env.CI }
    : undefined,
});
