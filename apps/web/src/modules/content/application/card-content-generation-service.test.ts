/**
 * 节点知识内容生成应用服务单元测试。
 *
 * 测试：
 * - CardContentGenerationService.request：冻结节点、目标和画像快照并创建 card_content_generate 任务。
 * - CardContentGenerationService.request：已有成功内容时拒绝再次创建任务。
 */

import { describe, expect, it } from "vitest";

import type {
  AgentRunProductionResult,
  AgentRunSnapshot,
} from "@/modules/agent-run/domain/agent-run";

import {
  CardContentGenerationApplicationError,
  type CardContentGenerationAgentRunRequester,
  type CardContentGenerationContextRepository,
} from "../domain/content-generation";
import { CardContentGenerationService } from "./card-content-generation-service";

const ownerId = "d8418b49-5ca9-4aeb-b6e0-25b35b17fb8f";
const goalId = "04d90a58-a556-45d2-9e63-108e2a261d58";
const planId = "1c6a5f2b-88e7-489f-9a8f-03b1d1f95840";
const planNodeId = "a3da445d-3c9f-43e4-95b6-8b6a2e746a6f";

const agentRun: AgentRunSnapshot = {
  id: "c5c67616-0cd0-43e4-91ef-182d5e6e5c31",
  runType: "card_content_generate",
  status: "queued",
  targetType: "plan_node",
  targetId: planNodeId,
  modelConnectionId: null,
  requestedModelId: null,
  retryCount: 0,
  traceId: "eb9cdcd0-3a37-4bb3-97f3-dbd6a71a6740",
  startedAt: null,
  finishedAt: null,
  createdAt: new Date("2026-08-26T00:00:00.000Z"),
  updatedAt: new Date("2026-08-26T00:00:00.000Z"),
};

class FakeContextRepository implements CardContentGenerationContextRepository {
  contentStatus: "not_requested" | "generating" | "ready" | "failed" = "not_requested";

  async findOwnedNodeContext() {
    return {
      goalId,
      planId,
      planNodeId,
      topic: "Python 数据分析",
      goalTitle: "掌握 Python 数据分析",
      desiredOutcome: "能独立完成常见数据分析任务。",
      profileVersion: 3,
      currentLevel: "beginner" as const,
      weeklyMinutes: 360,
      backgroundSummary: "具备基础编程经验。",
      nodeKey: "chapter-01",
      nodeTitle: "Python 语法基础",
      nodeBrief: "掌握变量、表达式、控制流和函数调用。",
      learningObjective: "能够编写基础 Python 程序。",
      rationale: "为数据结构和数据分析库建立语言基础。",
      difficulty: 1,
      estimatedMinutes: 90,
      completionCriteria: ["能编写条件和循环", "能调用自定义函数"],
      contentStatus: this.contentStatus,
    };
  }

  async hasDefaultModelConnection() {
    return true;
  }
}

class FakeAgentRunRequester implements CardContentGenerationAgentRunRequester {
  input: Parameters<CardContentGenerationAgentRunRequester["request"]>[0] | null = null;

  async request(
    input: Parameters<CardContentGenerationAgentRunRequester["request"]>[0],
  ): Promise<AgentRunProductionResult> {
    this.input = input;
    return { agentRun, created: true };
  }
}

describe("CardContentGenerationService", () => {
  it("创建 node_tutor 的节点内容生成任务并冻结结构化快照", async () => {
    const requester = new FakeAgentRunRequester();
    const service = new CardContentGenerationService(new FakeContextRepository(), requester);

    await expect(service.request({
      ownerId,
      planNodeId,
      idempotencyKey: "b9a3bbb1-0b6d-476d-9038-c50b192df519",
    })).resolves.toMatchObject({ created: true });

    expect(requester.input).toMatchObject({
      goalId,
      runType: "card_content_generate",
      targetType: "plan_node",
      targetId: planNodeId,
      graphVersion: "card_content_generate.v1",
      inputSummaryJson: {
        agent_role: "node_tutor",
        logical_session_key: "node:" + planNodeId,
        goal: { id: goalId },
        learning_plan: { id: planId },
        plan_node: {
          id: planNodeId,
          node_brief: "掌握变量、表达式、控制流和函数调用。",
        },
      },
    });
  });

  it("已有成功内容时拒绝第二次生成", async () => {
    const contextRepository = new FakeContextRepository();
    contextRepository.contentStatus = "ready";
    const requester = new FakeAgentRunRequester();
    const service = new CardContentGenerationService(contextRepository, requester);

    await expect(service.request({
      ownerId,
      planNodeId,
      idempotencyKey: "b9a3bbb1-0b6d-476d-9038-c50b192df519",
    })).rejects.toMatchObject({
      code: "CARD_CONTENT_ALREADY_AVAILABLE",
    } satisfies Partial<CardContentGenerationApplicationError>);
    expect(requester.input).toBeNull();
  });
});
