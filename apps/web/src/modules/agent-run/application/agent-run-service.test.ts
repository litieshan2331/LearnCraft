/**
 * AgentRun 应用服务的单元测试。
 *
 * 测试：
 * - AgentRunService.request：验证生产者生成 trace_id 并交给受信任的持久化端口。
 * - AgentRunService.getOwnedRun、cancelOwnedRun：验证资源不存在和不可取消状态的稳定错误映射。
 */

import { describe, expect, it } from "vitest";

import {
  type AgentRunCancellationResult,
  type AgentRunProductionInput,
  type AgentRunProductionResult,
  type AgentRunRepository,
  type AgentRunSnapshot,
} from "../domain/agent-run";
import { AgentRunService } from "./agent-run-service";

const agentRun: AgentRunSnapshot = {
  id: "a3da445d-3c9f-43e4-95b6-8b6a2e746a6f",
  runType: "plan_generate",
  status: "queued",
  targetType: "learning_goal",
  targetId: "04d90a58-a556-45d2-9e63-108e2a261d58",
  modelConnectionId: null,
  requestedModelId: null,
  retryCount: 0,
  traceId: "a033b384-aaf8-42e8-b975-08ef1bd4923d",
  startedAt: null,
  finishedAt: null,
  createdAt: new Date("2026-07-26T00:00:00.000Z"),
  updatedAt: new Date("2026-07-26T00:00:00.000Z"),
};

class FakeAgentRunRepository implements AgentRunRepository {
  createdInput: AgentRunProductionInput | null = null;
  foundRun: AgentRunSnapshot | null = agentRun;
  cancellationResult: AgentRunCancellationResult = {
    decision: "cancel",
    agentRun,
  };

  async create(input: AgentRunProductionInput): Promise<AgentRunProductionResult> {
    this.createdInput = input;
    return { agentRun: { ...agentRun, traceId: input.traceId }, created: true };
  }

  async findOwnedRun(): Promise<AgentRunSnapshot | null> {
    return this.foundRun;
  }

  async cancelOwnedRun(): Promise<AgentRunCancellationResult> {
    return this.cancellationResult;
  }
}

describe("AgentRunService", () => {
  it("创建任务时生成可关联 Outbox 与 Worker 的 trace_id", async () => {
    const repository = new FakeAgentRunRepository();
    const service = new AgentRunService(repository);

    await service.request({
      ownerId: "d8418b49-5ca9-4aeb-b6e0-25b35b17fb8f",
      goalId: "04d90a58-a556-45d2-9e63-108e2a261d58",
      runType: "plan_generate",
      targetType: "learning_goal",
      targetId: "04d90a58-a556-45d2-9e63-108e2a261d58",
      idempotencyKey: "b9a3bbb1-0b6d-476d-9038-c50b192df519",
      graphVersion: "v1",
      inputSchemaVersion: "v1",
      requestedModelProfile: "default",
    });

    expect(repository.createdInput?.traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("将所有者不可见的任务映射为不泄露资源存在的错误", async () => {
    const repository = new FakeAgentRunRepository();
    repository.foundRun = null;
    const service = new AgentRunService(repository);

    await expect(service.getOwnedRun("owner", agentRun.id))
      .rejects.toMatchObject({ code: "AGENT_RUN_NOT_FOUND" });
  });

  it("拒绝取消已经结束的任务", async () => {
    const repository = new FakeAgentRunRepository();
    repository.cancellationResult = {
      decision: "not_cancellable",
      agentRun: { ...agentRun, status: "succeeded" },
    };
    const service = new AgentRunService(repository);

    await expect(service.cancelOwnedRun("owner", agentRun.id))
      .rejects.toMatchObject({ code: "AGENT_RUN_NOT_CANCELLABLE" });
  });
});
