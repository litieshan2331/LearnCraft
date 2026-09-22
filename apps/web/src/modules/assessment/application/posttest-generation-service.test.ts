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
  availability: "available" | "active" | "awaiting_attempt" = "available";

  async findOwnedNodeContext() {
    return this.contextAvailable
      ? { goalId, planNodeId, cardContentId, topic: "TypeScript" }
      : null;
  }

  async hasDefaultModelConnection() {
    return true;
  }

  async getGenerationAvailability() {
    return this.availability;
  }
}

class FakeAgentRunRequester implements PosttestGenerationAgentRunRequester {
  input: Parameters<PosttestGenerationAgentRunRequester["request"]>[0] | null = null;

  inFlightRun: AgentRunSnapshot | null = null;

  async request(input: Parameters<PosttestGenerationAgentRunRequester["request"]>[0]): Promise<AgentRunProductionResult> {
    this.input = input;
    return { agentRun, created: true };
  }

  async findInFlightRun(): Promise<AgentRunSnapshot | null> {
    return this.inFlightRun;
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

  it("最新后测未完成时禁止生成下一套", async () => {
    const contextRepository = new FakeContextRepository();
    contextRepository.availability = "awaiting_attempt";
    const service = new PosttestGenerationService(contextRepository, new FakeAgentRunRequester());

    await expect(service.request({
      ownerId,
      planNodeId,
      questionCount: 6,
      difficulty: "normal",
      idempotencyKey: "d9a3bbb1-0b6d-476d-9038-c50b192df519",
    })).rejects.toMatchObject({ code: "POSTTEST_ATTEMPT_REQUIRED" });
  });

  it("后测生成任务进行中时返回既有任务而不重复创建", async () => {
    const contextRepository = new FakeContextRepository();
    contextRepository.availability = "active";
    const requester = new FakeAgentRunRequester();
    requester.inFlightRun = agentRun;
    const service = new PosttestGenerationService(contextRepository, requester);

    await expect(service.request({
      ownerId,
      planNodeId,
      questionCount: 6,
      difficulty: "normal",
      idempotencyKey: "e9a3bbb1-0b6d-476d-9038-c50b192df519",
    })).resolves.toEqual({ agentRun, created: false });

    expect(requester.input).toBeNull();
  });

  it("可用性为 active 但查不到在途任务时仍报冲突", async () => {
    const contextRepository = new FakeContextRepository();
    contextRepository.availability = "active";
    const service = new PosttestGenerationService(contextRepository, new FakeAgentRunRequester());

    await expect(service.request({
      ownerId,
      planNodeId,
      questionCount: 6,
      difficulty: "normal",
      idempotencyKey: "f9a3bbb1-0b6d-476d-9038-c50b192df519",
    })).rejects.toMatchObject({ code: "POSTTEST_GENERATION_IN_PROGRESS" });
  });

  it("节点没有 ready 内容时返回独立错误码", async () => {
    const service = new PosttestGenerationService({
      findOwnedNodeContext: async () => ({ goalId, planNodeId, cardContentId: null, topic: "TypeScript" }),
      hasDefaultModelConnection: async () => true,
      getGenerationAvailability: async () => "available" as const,
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