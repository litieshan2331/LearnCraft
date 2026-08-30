/**
 * 节点后测生成应用服务单元测试。
 *
 * 测试：
 * - PosttestGenerationService.request：验证目标为 plan_node 且输入绑定 source_card_content_id。
 * - PosttestGenerationService.request：验证节点未找到或内容未 ready 时拒绝创建任务。
 */

import { describe, expect, it } from "vitest";

import type {
  AgentRunProductionResult,
  AgentRunSnapshot,
} from "@/modules/agent-run/domain/agent-run";

import {
  PosttestGenerationApplicationError,
  type PosttestGenerationAgentRunRequester,
  type PosttestGenerationContextRepository,
} from "../domain/posttest-generation";
import { PosttestGenerationService } from "./posttest-generation-service";

const ownerId = "d8418b49-5ca9-4aeb-b6e0-25b35b17fb8f";
const goalId = "04d90a58-a556-45d2-9e63-108e2a261d58";
const planNodeId = "1c6a5f2b-88e7-489f-9a8f-03b1d1f95840";
const cardContentId = "a3da445d-3c9f-43e4-95b6-8b6a2e746a6f";

const agentRun: AgentRunSnapshot = {
  id: "f18621a7-4309-4a04-9769-4d602966a574",
  runType: "posttest_generate",
  status: "queued",
  targetType: "plan_node",
  targetId: planNodeId,
  modelConnectionId: null,
  requestedModelId: null,
  retryCount: 0,
  traceId: "a033b384-aaf8-42e8-b975-08ef1bd4923d",
  startedAt: null,
  finishedAt: null,
  createdAt: new Date("2026-08-24T00:00:00.000Z"),
  updatedAt: new Date("2026-08-24T00:00:00.000Z"),
};

class FakeContextRepository implements PosttestGenerationContextRepository {
  contextAvailable = true;

  async findOwnedNodeContext() {
    return this.contextAvailable
      ? { goalId, planNodeId, cardContentId, topic: "TypeScript" }
      : null;
  }

  async hasDefaultModelConnection() {
    return true;
  }
}

class FakeAgentRunRequester implements PosttestGenerationAgentRunRequester {
  input: Parameters<PosttestGenerationAgentRunRequester["request"]>[0] | null = null;

  async request(input: Parameters<PosttestGenerationAgentRunRequester["request"]>[0]): Promise<AgentRunProductionResult> {
    this.input = input;
    return { agentRun, created: true };
  }
}

describe("PosttestGenerationService", () => {
  it("为 plan_node 创建并绑定节点内容的 posttest_generate", async () => {
    const requester = new FakeAgentRunRequester();
    const service = new PosttestGenerationService(new FakeContextRepository(), requester);

    const result = await service.request({
      ownerId,
      planNodeId,
      questionCount: 6,
      difficulty: "normal",
      idempotencyKey: "b9a3bbb1-0b6d-476d-9038-c50b192df519",
    });

    expect(result.created).toBe(true);
    expect(requester.input).toMatchObject({
      goalId,
      runType: "posttest_generate",
      targetType: "plan_node",
      targetId: planNodeId,
      inputSummaryJson: {
        kind: "post_test",
        plan_node_id: planNodeId,
        source_card_content_id: cardContentId,
        question_count: 6,
      },
    });
  });

  it("没有成功内容时不创建后测任务", async () => {
    const contextRepository = new FakeContextRepository();
    contextRepository.contextAvailable = false;
    const service = new PosttestGenerationService(contextRepository, new FakeAgentRunRequester());

    await expect(service.request({
      ownerId,
      planNodeId,
      questionCount: 6,
      difficulty: "normal",
      idempotencyKey: "b9a3bbb1-0b6d-476d-9038-c50b192df519",
    })).rejects.toMatchObject({
      code: "PLAN_NODE_NOT_FOUND",
    } satisfies Partial<PosttestGenerationApplicationError>);
  });

  it("节点没有 ready 内容时返回独立错误码", async () => {
    const service = new PosttestGenerationService({
      findOwnedNodeContext: async () => ({ goalId, planNodeId, cardContentId: null, topic: "TypeScript" }),
      hasDefaultModelConnection: async () => true,
    }, new FakeAgentRunRequester());

    await expect(service.request({
      ownerId,
      planNodeId,
      questionCount: 6,
      difficulty: "normal",
      idempotencyKey: "c9a3bbb1-0b6d-476d-9038-c50b192df519",
    })).rejects.toMatchObject({
      code: "CARD_CONTENT_NOT_READY",
    } satisfies Partial<PosttestGenerationApplicationError>);
  });
});