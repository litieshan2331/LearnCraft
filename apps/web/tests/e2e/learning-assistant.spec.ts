/**
 * 学习助手浏览器验收场景。
 *
 * 调用顺序：登录测试用户打开学习起点 → 发送公开消息 → 等待运行终态 → 校验回复和安全状态。
 * 这些用例依赖隔离测试服务；未启用时 Playwright 不会自动回退到本地开发数据。
 */

import { test, expect } from "./fixtures";

test.describe("学习助手 E2E", () => {
  test.beforeEach(async ({}, testInfo) => {
    testInfo.annotations.push({ type: "environment", description: "显式测试 PostgreSQL、Redis、Web、Dispatcher、Worker 与 fake model" });
  });

  test("学习起点提供可访问的入口", async ({ page, openOnboarding }) => {
    await openOnboarding(page);
    await expect(page.getByRole("button", { name: /展开学习助手/ })).toBeVisible();
  });

  test("发送消息后展示公开回复和教学状态", async ({ page, openOnboarding }) => {
    await openOnboarding(page);
    await page.getByRole("button", { name: /展开学习助手/ }).click();
    await expect(page.getByLabel("学习助手对话")).toBeVisible();
    const input = page.getByRole("textbox", { name: "输入消息" });
    await input.fill("[[e2e:ordinary]] 请解释这个循环的边界条件");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByText(/阶段：|提示级别：/).first()).toBeVisible();
    await expect(page.getByText("请解释这个循环的边界条件")).toBeVisible();
    await expect(page.getByText("循环边界应小于数组长度。")).toBeVisible();
  });

  test("刷新后保留会话入口并隐藏工具载荷", async ({ page, openOnboarding }) => {
    await openOnboarding(page);
    await page.getByRole("button", { name: /展开学习助手/ }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: /学习助手/ })).toBeVisible();
    await expect(page.getByText(/tool_name|tool_result|内部工具/)).toHaveCount(0);
  });

  test("提示级别由服务端 State 展示，不从回复文本猜测", async ({ page, openOnboarding }) => {
    await openOnboarding(page);
    await page.getByRole("button", { name: /展开学习助手/ }).click();
    const input = page.getByRole("textbox", { name: "输入消息" });
    await input.fill("[[e2e:hint-upgrade]] 请继续引导");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByText("提示级别：0")).toBeVisible();
  });

  test("模型失败只展示统一安全文案", async ({ page, openOnboarding }) => {
    await openOnboarding(page);
    await page.getByRole("button", { name: /展开学习助手/ }).click();
    await page.getByRole("textbox", { name: "输入消息" }).fill("[[e2e:model-failure]] 模拟失败");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByText("本次回复生成失败，请稍后重试。")).toBeVisible();
    await expect(page.getByText(/FAKE_MODEL_FAILURE|凭据|工具载荷/)).toHaveCount(0);
  });
});
