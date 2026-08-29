/**
 * 学习计划与节点查询应用服务单元测试。
 *
 * 测试：
 * - PlanQueryService：返回当前用户拥有的路线和节点快照。
 * - PlanQueryService：资源不存在时返回稳定错误码。
 */

import { describe, expect, it } from "vitest";

import {
  PlanQueryServiceError,
  type LearningPlanSnapshot,
  type PlanNodeSnapshot,
  type PlanQueryRepository,
} from "../domain/plan-query";
import { PlanQueryService } from "./plan-query-service";

const ownerId = "d8418b49-5ca9-4aeb-b6e0-25b35b17fb8f";
const planId = "04d90a58-a556-45d2-9e63-108e2a261d58";
const nodeId = "1c6a5f2b-88e7-489f-9a8f-03b1d1f95840";

const node: PlanNodeSnapshot = {
  id: nodeId,
  goalId: "a3da445d-3c9f-43e4-95b6-8b6a2e746a6f",
  planId,
  planTitle: "Python 数据分析",
  planStatus: "active",
  nodeKey: "chapter-01",
  ordinal: 1,
  title: "语法基础",
  nodeBrief: "掌握变量、表达式和控制流。",
  learningObjective: "能够编写简单 Python 程序。",
  rationale: "为后续函数和数据结构打基础。",
  difficulty: 1,
  estimatedMinutes: 60,
  completionCriteria: ["能解释变量和表达式", "能完成基础练习"],
  status: "available",
  contentStatus: "not_started",
  cardContentId: null,
  prerequisiteNodeIds: [],
};

const plan: LearningPlanSnapshot = {
  id: planId,
  goalId: node.goalId,
  version: 1,
  title: "Python 数据分析",
  summary: "按章节逐步建立 Python 基础。",
  status: "active",
  profileVersion: 3,
  schemaVersion: "learning_plan.v1",
  nodes: [node],
  createdAt: new Date("2026-08-25T00:00:00.000Z"),
  updatedAt: new Date("2026-08-25T00:00:00.000Z"),
};

class FakePlanQueryRepository implements PlanQueryRepository {
  planAvailable = true;
  nodeAvailable = true;

  async findOwnedPlan() {
    return this.planAvailable ? plan : null;
  }

  async findOwnedNode() {
    return this.nodeAvailable ? node : null;
  }
}

describe("PlanQueryService", () => {
  it("读取路线及其章节目录", async () => {
    const service = new PlanQueryService(new FakePlanQueryRepository());

    await expect(service.getOwnedPlan(ownerId, planId)).resolves.toEqual(plan);
  });

  it("读取单个章节及所属路线信息", async () => {
    const service = new PlanQueryService(new FakePlanQueryRepository());

    await expect(service.getOwnedNode(ownerId, nodeId)).resolves.toEqual(node);
  });

  it("路线不存在时返回稳定错误码", async () => {
    const repository = new FakePlanQueryRepository();
    repository.planAvailable = false;

    await expect(new PlanQueryService(repository).getOwnedPlan(ownerId, planId))
      .rejects.toMatchObject({ code: "LEARNING_PLAN_NOT_FOUND" } satisfies Partial<PlanQueryServiceError>);
  });

  it("节点不存在时返回稳定错误码", async () => {
    const repository = new FakePlanQueryRepository();
    repository.nodeAvailable = false;

    await expect(new PlanQueryService(repository).getOwnedNode(ownerId, nodeId))
      .rejects.toMatchObject({ code: "PLAN_NODE_NOT_FOUND" } satisfies Partial<PlanQueryServiceError>);
  });
});
