/**
 * 学习助手 Playwright 夹具。
 *
 * 调用顺序：读取测试账号并打开学习起点 → 如未登录则建立 Session → 验证可访问的学习助手入口。
 * 测试账号和数据清理由隔离测试环境负责；当前夹具不删除数据库或 Redis 资源。
 */

/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixture callbacks are conventionally named use. */

import { test as base, expect, type Page } from "@playwright/test";

export type LearningAssistantFixture = {
  openOnboarding(page: Page): Promise<void>;
};

export const test = base.extend<LearningAssistantFixture>({
  openOnboarding: async ({}, use) => use(async (page) => {
    await page.goto("/onboarding");
    if (new URL(page.url()).pathname === "/login") {
      await page.getByLabel("邮箱").fill(process.env.LEARNING_ASSISTANT_E2E_TEST_USER_EMAIL!);
      await page.getByLabel("密码").fill(process.env.LEARNING_ASSISTANT_E2E_TEST_USER_PASSWORD!);
      await page.getByRole("button", { name: /登录/ }).click();
      await page.waitForURL("**/onboarding");
    }
    await expect(page.getByRole("button", { name: /学习助手/ })).toBeVisible();
  }),
});

export { expect };
