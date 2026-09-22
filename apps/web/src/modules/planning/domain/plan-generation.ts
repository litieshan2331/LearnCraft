/**
 * 学习路线生成用例的领域契约。
 *
 * 导出：
 * - PlanGenerationRequest：用户确认后的路线生成请求。
 * - PlanGenerationContext：路线生成所需的目标、当前画像与已评分前测快照。
 * - PlanGenerationContextRepository：读取路线生成前置条件。
 * - PlanGenerationApplicationError：映射稳定的业务错误码。
 */

import type { AgentRunProductionResult, AgentRunSnapshot } from "@/modules/agent-run/domain/agent-run";

export interface PlanGenerationRequest {
  ownerId: string;
  goalId: string;
  idempotencyKey: string;
}

export interface PlanGenerationContext {
  goalId: string;
  topic: string;
  title: string;
  description: string;
  desiredOutcome: string;
  profileVersion: number;
  currentLevel: "beginner" | "intermediate" | "advanced";
  weeklyMinutes: number;
  backgroundSummary: string | null;
  assessmentId: string;
  assessmentScorePercent: number;
  assessmentMasterySummary: Record<string, unknown>;
}

export interface PlanGenerationContextRepository {
  findOwnedReadyContext(ownerId: string, goalId: string): Promise<PlanGenerationContext | null>;
  hasDefaultModelConnection(ownerId: string): Promise<boolean>;
}

export interface PlanGenerationAgentRunRequester {
  request(input: {
    ownerId: string;
    goalId: string;
    runType: "plan_generate";
    targetType: "learning_goal";
    targetId: string;
    idempotencyKey: string;
    graphVersion: string;
    promptVersion: string;
    inputSchemaVersion: string;
    outputSchemaVersion: string;
    requestedModelProfile: string;
    inputSummaryJson: Record<string, unknown>;
  }): Promise<AgentRunProductionResult>;
  /** 目标级幂等：该目标已有在途（queued/running）的 plan_generate 任务时返回它。 */
  findInFlightRun(query: {
    ownerId: string;
    runType: "plan_generate";
    targetType: "learning_goal";
    targetId: string;
  }): Promise<AgentRunSnapshot | null>;
}

export type PlanGenerationApplicationErrorCode =
  | "PLAN_GENERATION_PREREQUISITES_NOT_MET"
  | "DEFAULT_MODEL_CONNECTION_REQUIRED";

export class PlanGenerationApplicationError extends Error {
  constructor(public readonly code: PlanGenerationApplicationErrorCode) {
    super(code);
    this.name = "PlanGenerationApplicationError";
  }
}