/**
 * Assessment 生成用例的领域模型与持久化端口。
 *
 * 导出：
 * - AssessmentGenerationRequest：前测/后测生成请求。
 * - AssessmentGenerationContext：生成 Prompt 所需的目标与画像快照。
 * - AssessmentGenerationContextRepository：读取当前用户可用目标与路线。
 * - AssessmentGenerationApplicationError：映射稳定的业务错误码。
 */

import type { AgentRunProductionResult } from "@/modules/agent-run/domain/agent-run";

export const ASSESSMENT_GENERATION_KINDS = ["diagnostic", "post_test"] as const;
export const ASSESSMENT_GENERATION_DIFFICULTIES = ["normal", "hard"] as const;

export type AssessmentGenerationKind = (typeof ASSESSMENT_GENERATION_KINDS)[number];
export type AssessmentGenerationDifficulty = (typeof ASSESSMENT_GENERATION_DIFFICULTIES)[number];

export interface AssessmentGenerationRequest {
  ownerId: string;
  goalId: string;
  kind: AssessmentGenerationKind;
  questionCount: number;
  difficulty: AssessmentGenerationDifficulty;
  planId: string | null;
  idempotencyKey: string;
}

export interface AssessmentGenerationContext {
  topic: string;
  title: string;
  description: string;
  desiredOutcome: string;
  backgroundSummary: string | null;
  overallExperience: string | null;
}

export interface AssessmentGenerationContextRepository {
  findOwnedGoalContext(ownerId: string, goalId: string): Promise<AssessmentGenerationContext | null>;
  hasOwnedPlan(ownerId: string, goalId: string, planId: string): Promise<boolean>;
  hasDefaultModelConnection(ownerId: string): Promise<boolean>;
}

export interface AssessmentGenerationAgentRunRequester {
  request(input: {
    ownerId: string;
    goalId: string;
    runType: "assessment_generate";
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
}

export type AssessmentGenerationApplicationErrorCode =
  | "LEARNING_GOAL_NOT_FOUND"
  | "LEARNING_PLAN_NOT_FOUND"
  | "DEFAULT_MODEL_CONNECTION_REQUIRED";

export class AssessmentGenerationApplicationError extends Error {
  constructor(public readonly code: AssessmentGenerationApplicationErrorCode) {
    super(code);
    this.name = "AssessmentGenerationApplicationError";
  }
}
