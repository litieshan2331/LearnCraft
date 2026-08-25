/**
 * Assessment 生成应用服务单元测试。
 *
 * 测试：
 * - AssessmentGenerationService.request：验证目标上下文、默认模型和 AgentRun 输入快照。

 */

import { describe, expect, it } from "vitest";

import type {
  AgentRunProductionResult,
  AgentRunSnapshot,
} from "@/modules/agent-run/domain/agent-run";

import {
  type AssessmentGenerationAgentRunRequester,
  type AssessmentGenerationContextRepository,
} from "../domain/assessment-generation";
import { AssessmentGenerationService } from "./assessment-generation-service";

const goalId = "04d90a58-a556-45d2-9e63-108e2a261d58";
const ownerId = "d8418b49-5ca9-4aeb-b6e0-25b35b17fb8f";

const agentRun: AgentRunSnapshot = {
  id: "a3da445d-3c9f-43e4-95b6-8b6a2e746a6f",
  runType: "assessment_generate",
  status: "queued",
  targetType: "learning_goal",
  targetId: goalId,
  modelConnectionId: null,
  requestedModelId: null,
  retryCount: 0,
  traceId: "a033b384-aaf8-42e8-b975-08ef1bd4923d",
  startedAt: null,
  finishedAt: null,
  createdAt: new Date("2026-07-26T00:00:00.000Z"),
  updatedAt: new Date("2026-07-26T00:00:00.000Z"),
};

class FakeContextRepository implements AssessmentGenerationContextRepository {
  hasModel = true;
  async findOwnedGoalContext() {
    return {
      topic: "TypeScript",
      title: "TypeScript 类型系统",
      description: "理解泛型、联合类型和类型收窄。",
      desiredOutcome: "能独立维护中型 TypeScript 项目。",
      backgroundSummary: "有 JavaScript 基础。",
      overallExperience: "intermediate",
    };
  }

  async hasDefaultModelConnection() {
    return this.hasModel;
  }
}

class FakeAgentRunRequester implements AssessmentGenerationAgentRunRequester {
  input: Parameters<AssessmentGenerationAgentRunRequester["request"]>[0] | null = null;

  async request(input: Parameters<AssessmentGenerationAgentRunRequester["request"]>[0]): Promise<AgentRunProductionResult> {
    this.input = input;
    return { agentRun, created: true };
  }
}

describe("AssessmentGenerationService", () => {
  it("将目标和画像快照组装为 assessment_generate AgentRun 输入", async () => {
    const requester = new FakeAgentRunRequester();
    const service = new AssessmentGenerationService(new FakeContextRepository(), requester);

    const result = await service.request({
      ownerId,
      goalId,
      kind: "diagnostic",
      questionCount: 10,
      difficulty: "hard",
      idempotencyKey: "b9a3bbb1-0b6d-476d-9038-c50b192df519",
    });

    expect(result.created).toBe(true);
    expect(requester.input).toMatchObject({
      goalId,
      runType: "assessment_generate",
      targetType: "learning_goal",
      targetId: goalId,
      graphVersion: "assessment_generate.v1",
      requestedModelProfile: "account_default_openai_compatible",
      inputSummaryJson: {
        topic: "TypeScript",
        question_count: 10,
        difficulty: "hard",
        kind: "diagnostic",
      },
    });
  });

});
