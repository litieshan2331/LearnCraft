/**
 * 学习助手 E2E 假模型合同测试。
 *
 * 调用顺序：装配本地 FakeLearningAssistantModel → 执行普通、自然语言委派和一次性崩溃脚本 →
 * 断言输出固定且没有任何网络端口调用。
 */

import { describe, expect, it } from "vitest";
import { FakeLearningAssistantModel } from "../src/testing/fake-learning-assistant-model.js";
import type { ModelCompletionRequest } from "../src/infrastructure/llm/model-gateway.js";

const request = { agentRunId: "fake-run", messages: [] } as unknown as ModelCompletionRequest;

describe("学习助手 E2E 假模型", () => {
  it("返回普通自然语言回答，不发起 HTTP 请求", async () => {
    const result = await new FakeLearningAssistantModel("ordinary").complete(request);
    expect(result.message.role).toBe("assistant");
    expect(result.message.content).toContain("循环边界");
  });

  it("支持一次性可重试崩溃脚本", async () => {
    const model = new FakeLearningAssistantModel("crash-once");
    await expect(model.complete(request)).rejects.toMatchObject({ message: "FAKE_WORKER_CRASH_ONCE", retryable: true });
    await expect(model.complete(request)).resolves.toMatchObject({ message: { role: "assistant" } });
  });

  it.each([
    ["wrong-answer", "analyze_wrong_answer"],
    ["hint-upgrade", "generate_socratic_question"],
    ["tool-failure", "tavily_search"],
  ] as const)("按 %s 场景返回可脚本化工具调用", async (scenario, toolName) => {
    const model = new FakeLearningAssistantModel(scenario);
    await expect(model.complete({ ...request, agentRunId: `run-${scenario}` }))
      .resolves.toMatchObject({ message: { toolCalls: [{ name: toolName }] } });
  });

  it("按消息标记覆盖场景且不同 run 的计数相互隔离", async () => {
    const model = new FakeLearningAssistantModel("ordinary");
    const wrongAnswer = { ...request, agentRunId: "run-a", messages: [{ role: "user", content: "[[e2e:wrong-answer]]" }] } as unknown as ModelCompletionRequest;
    const ordinary = { ...request, agentRunId: "run-b", messages: [{ role: "user", content: "ordinary" }] } as unknown as ModelCompletionRequest;
    await expect(model.complete(wrongAnswer)).resolves.toMatchObject({ message: { toolCalls: [{ name: "analyze_wrong_answer" }] } });
    await expect(model.complete(ordinary)).resolves.toMatchObject({ message: { content: '循环边界应小于数组长度。' } });
  });
});
