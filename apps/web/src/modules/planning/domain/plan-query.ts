/**
 * 学习计划与节点查询领域契约。
 *
 * 导出：
 * - LearningPlanNodeSnapshot：路线章节及其前置节点。
 * - LearningPlanSnapshot：路线详情与章节列表。
 * - PlanNodeSnapshot：单个章节详情。
 * - PlanQueryRepository：按所有者读取路线和节点的持久化端口。
 * - PlanQueryServiceError：查询用例稳定错误。
 */

export interface LearningPlanNodeSnapshot {
  id: string;
  planId: string;
  nodeKey: string;
  ordinal: number;
  title: string;
  nodeBrief: string;
  learningObjective: string;
  rationale: string | null;
  difficulty: number;
  estimatedMinutes: number;
  completionCriteria: string[];
  status: string;
  contentStatus: string;
  cardContentId: string | null;
  prerequisiteNodeIds: string[];
}

export interface LearningPlanSnapshot {
  id: string;
  goalId: string;
  version: number;
  title: string;
  summary: string | null;
  status: string;
  profileVersion: number;
  schemaVersion: string;
  nodes: LearningPlanNodeSnapshot[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PlanNodeSnapshot extends LearningPlanNodeSnapshot {
  goalId: string;
  planTitle: string;
  planStatus: string;
  /** 该节点正在执行的 card_content_generate 运行 id；没有在途任务时为 null。 */
  latestContentRunId: string | null;
  /** 该节点正在执行的 posttest_generate 运行 id；没有在途任务时为 null。 */
  latestPosttestRunId: string | null;
}

export interface PlanQueryRepository {
  findOwnedPlan(ownerId: string, planId: string): Promise<LearningPlanSnapshot | null>;
  findOwnedNode(ownerId: string, nodeId: string): Promise<PlanNodeSnapshot | null>;
}

export type PlanQueryErrorCode = "LEARNING_PLAN_NOT_FOUND" | "PLAN_NODE_NOT_FOUND";

export class PlanQueryServiceError extends Error {
  constructor(public readonly code: PlanQueryErrorCode) {
    super(code);
    this.name = "PlanQueryServiceError";
  }
}