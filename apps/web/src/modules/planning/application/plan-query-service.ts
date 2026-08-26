/**
 * 学习计划与节点查询应用服务。
 *
 * 导出：
 * - PlanQueryService：按当前用户所有权读取路线和章节详情。
 */

import {
  PlanQueryServiceError,
  type PlanQueryRepository,
  type LearningPlanSnapshot,
  type PlanNodeSnapshot,
} from "../domain/plan-query";

export class PlanQueryService {
  constructor(private readonly repository: PlanQueryRepository) {}

  async getOwnedPlan(ownerId: string, planId: string): Promise<LearningPlanSnapshot> {
    const plan = await this.repository.findOwnedPlan(ownerId, planId);
    if (!plan) {
      throw new PlanQueryServiceError("LEARNING_PLAN_NOT_FOUND");
    }
    return plan;
  }

  async getOwnedNode(ownerId: string, nodeId: string): Promise<PlanNodeSnapshot> {
    const node = await this.repository.findOwnedNode(ownerId, nodeId);
    if (!node) {
      throw new PlanQueryServiceError("PLAN_NODE_NOT_FOUND");
    }
    return node;
  }
}