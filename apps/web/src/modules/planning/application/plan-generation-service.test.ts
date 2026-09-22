/**
 * 学习路线生成应用服务单元测试。
 *
 * 测试：
 * - PlanGenerationService.request：使用已评分前测与当前画像创建 plan_generate AgentRun。
 * - PlanGenerationService.request：前置条件不满足时拒绝创建任务。
 */

import { describe, expect, it } from "vitest";

import type {
  AgentRunProductionResult,
  AgentRunSnapshot,
} from "@/modules/agent-run/domain/agent-run";

import {
  PlanGenerationApplicationError,
  type PlanGenerationAgentRunRequester,
  type PlanGenerationContextRepository,
} from "../domain/plan-generation";
import { PlanGenerationService } from "./plan-generation-service";

const ownerId = "d8418b49-5ca9-4aeb-b6e0-25b35b17fb8f";
const goalId = "04d90a58-a556-45d2-9e63-108e2a261d58";
const assessmentId = "1c6a5f2b-88e7-489f-9a8f-03b1d1f95840";

const agentRun: AgentRunSnapshot = {
  id: "a3da445d-3c9f-43e4-95b6-8b6a2e746a6f",
  runType: "plan_generate",
  status: "queued",
  targetType: "learning_goal",
  targetId: goalId,
  modelConnectionId: null,
  requestedModelId: null,
  retryCount: 0,
  traceId: "a033b384-aaf8-42e8-b975-08ef1bd4923d",
  startedAt: null,
  finishedAt: null,
  createdAt: new Date("2026-08-25T00:00:00.000Z"),
  updatedAt: new Date("2026-08-25T00:00:00.000Z"),
};

class FakeContextRepository implements PlanGenerationContextRepository {
  contextAvailable = true;

  async findOwnedReadyContext() {
    return this.contextAvailable
      ? {
        goalId,
        topic: "TypeScript 类型系统",
        title: "掌握 TypeScript 类型系统",
        description: "理解泛型、联合类型和类型收窄。",
        desiredOutcome: "能独立维护中型 TypeScript 项目。",
        profileVersion: 3,
        currentLevel: "intermediate" as const,
        weeklyMinutes: 360,
        backgroundSummary: "有 JavaScript 基础。",
        assessmentId,
        assessmentScorePercent: 65,
        assessmentMasterySummary: {
          incorrect_count: 4,
          skill_tag_results: { generics: { correct: 0, total: 2 } },
        },
      }
      : null;
  }

  async hasDefaultModelConnection() {
    return true;
  }
}

class FakeAgentRunRequester implements PlanGenerationAgentRunRequester {
  input: Parameters<PlanGenerationAgentRunRequester["request"]>[0] | null = null;

  inFlightRun: AgentRunSnapshot | null = null;

  async request(input: Parameters<PlanGenerationAgentRunRequester["request"]>[0]): Promise<AgentRunProductionResult> {
    this.input = input;
    return { agentRun, created: true };
  }

  async findInFlightRun(): Promise<AgentRunSnapshot | null> {
    return this.inFlightRun;
  }
}

describe("PlanGenerationService", () => {
  it("将目标、当前画像和已评分前测快照组装为 plan_generate 输入", async () => {
    const requester = new FakeAgentRunRequester();
    const service = new PlanGenerationService(new FakeContextRepository(), requester);

    const result = await service.request({
      ownerId,
      goalId,
      idempotencyKey: "b9a3bbb1-0b6d-476d-9038-c50b192df519",
    });

    expect(result.created).toBe(true);
    expect(requester.input).toMatchObject({
      goalId,
      runType: "plan_generate",
      targetType: "learning_goal",
      targetId: goalId,
      graphVersion: "plan_generate.v1",
      inputSummaryJson: {
        goal: { id: goalId },
        learner_profile: { profile_version: 3, current_level: "intermediate" },
        diagnostic_assessment: {
          assessment_id: assessmentId,
          score_percent: 65,
        },
      },
    });
  });

  it("没有已评分前测或当前画像时拒绝创建路线任务", async () => {
    const contextRepository = new FakeContextRepository();
    contextRepository.contextAvailable = false;
    const service = new PlanGenerationService(contextRepository, new FakeAgentRunRequester());

    await expect(service.request({
      ownerId,
      goalId,
      idempotencyKey: "b9a3bbb1-0b6d-476d-9038-c50b192df519",
    })).rejects.toMatchObject({
      code: "PLAN_GENERATION_PREREQUISITES_NOT_MET",
    } satisfies Partial<PlanGenerationApplicationError>);
  });

  it("目标已有在途路线任务时返回它而不重复创建", async () => {
    const requester = new FakeAgentRunRequester();
    requester.inFlightRun = agentRun;
    const service = new PlanGenerationService(new FakeContextRepository(), requester);

    await expect(service.request({
      ownerId,
      goalId,
      idempotencyKey: "c9a3bbb1-0b6d-476d-9038-c50b192df519",
    })).resolves.toEqual({ agentRun, created: false });

    expect(requester.input).toBeNull();
  });
});