/**
 * 学习助手 E2E 假模型端口。
 *
 * 调用顺序：读取 `LEARNING_ASSISTANT_E2E_FAKE_SCENARIO` → 按调用次数返回固定自然语言消息或可重试故障。
 * 该实现不创建 HTTP 客户端、不读取模型密钥，仅允许在显式 E2E fake 模式下装配。
 */

import type { ModelCompletionRequest, ModelCompletionResponse, ModelMessage } from "../infrastructure/llm/model-gateway.js";
import type { ModelPort } from "../workflows/learning-assistant/ports.js";

export type FakeLearningAssistantScenario =
  | "ordinary"
  | "wrong-answer"
  | "hint-upgrade"
  | "insufficient-evidence"
  | "model-failure"
  | "tool-failure"
  | "crash-once";

/** 可脚本化的模型实现；所有输出均为本地固定值。 */
export class FakeLearningAssistantModel implements ModelPort {
  private readonly callsByRun = new Map<string, number>();

  constructor(private readonly scenario: FakeLearningAssistantScenario = "ordinary") {}

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse> {
    const scenario = this.scenarioFor(request);
    const calls = (this.callsByRun.get(request.agentRunId) ?? 0) + 1;
    this.callsByRun.set(request.agentRunId, calls);
    if (scenario === "model-failure") throw new Error("FAKE_MODEL_FAILURE");
    if (scenario === "crash-once" && calls === 1) {
      const error = new Error("FAKE_WORKER_CRASH_ONCE") as Error & { retryable: boolean };
      error.retryable = true;
      throw error;
    }
    if (scenario === "tool-failure" && calls === 1) {
      return this.response({ role: "assistant", content: null, toolCalls: [{ id: "fake-tool", name: "tavily_search", argumentsJson: JSON.stringify({ query: "test" }) }] });
    }
    if (scenario === "wrong-answer" && calls === 1) {
      return this.response({ role: "assistant", content: null, toolCalls: [{ id: "fake-wrong-answer", name: "analyze_wrong_answer", argumentsJson: JSON.stringify({ task: "分析错题" }) }] });
    }
    if (scenario === "wrong-answer" && calls === 2) return this.response(this.attribution());
    if (scenario === "wrong-answer" && calls === 3) {
      return this.response({ role: "assistant", content: null, toolCalls: [{ id: "fake-tutor", name: "generate_socratic_question", argumentsJson: JSON.stringify({ task: "提出一个验证问题" }) }] });
    }
    if ((scenario === "wrong-answer" && calls === 4) || (scenario === "hint-upgrade" && calls === 2)) {
      return this.response(this.tutor());
    }
    if (scenario === "hint-upgrade" && calls === 1) {
      return this.response({ role: "assistant", content: null, toolCalls: [{ id: "fake-tutor", name: "generate_socratic_question", argumentsJson: JSON.stringify({ task: "升级提示并验证理解" }) }] });
    }
    return this.response({
      role: "assistant",
      content: scenario === "insufficient-evidence" ? "目前证据不足，先保留这个判断。" : "循环边界应小于数组长度。",
    });
  }

  private response(message: ModelMessage): ModelCompletionResponse {
    return { message, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
  }

  private scenarioFor(request: ModelCompletionRequest): FakeLearningAssistantScenario {
    const messageText = request.messages.map((message) => message.content ?? "").join("\n");
    const match = /\[\[e2e:([a-z-]+)\]\]/g;
    let selected: string | undefined;
    for (const item of messageText.matchAll(match)) selected = item[1];
    const scenarios: readonly string[] = [
      "ordinary", "wrong-answer", "hint-upgrade", "insufficient-evidence", "model-failure", "tool-failure", "crash-once",
    ];
    if (selected !== undefined && scenarios.includes(selected)) return selected as FakeLearningAssistantScenario;
    return this.scenario;
  }

  private attribution(): ModelMessage {
    return {
      role: "assistant",
      content: "当前证据不足以确认错误来源，请展示最后一次迭代的推演过程。",
    };
  }

  private tutor(): ModelMessage {
    return {
      role: "assistant",
      content: "从循环边界开始推演。请指出最后一次迭代的下标？",
    };
  }
}

/** 从环境变量读取严格限定的假模型场景；未知值直接失败，避免静默使用真实 Provider。 */
export function readFakeLearningAssistantScenario(): FakeLearningAssistantScenario {
  const value = process.env.LEARNING_ASSISTANT_E2E_FAKE_SCENARIO?.trim() || "ordinary";
  const allowed: readonly FakeLearningAssistantScenario[] = [
    "ordinary", "wrong-answer", "hint-upgrade", "insufficient-evidence", "model-failure", "tool-failure", "crash-once",
  ];
  if (!allowed.includes(value as FakeLearningAssistantScenario)) throw new Error("不支持的学习助手假模型场景。");
  return value as FakeLearningAssistantScenario;
}
