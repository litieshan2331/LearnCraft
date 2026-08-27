/**
 * 节点知识内容生成用例的领域契约。
 *
 * 导出：
 * - CardContentGenerationRequest：用户首次请求节点内容的输入。
 * - CardContentGenerationContext：冻结到 AgentRun 的目标、画像与节点快照。
 * - CardContentGenerationContextRepository：读取节点内容生成的前置条件。
 * - CardContentGenerationApplicationError：映射稳定的内容生成业务错误。
 */

import type { AgentRunProductionResult } from "@/modules/agent-run/domain/agent-run";

export interface CardContentGenerationRequest {
  ownerId: string;
  planNodeId: string;
  idempotencyKey: string;
}

export interface CardContentGenerationContext {
  goalId: string;
  planId: string;
  planNodeId: string;
  topic: string;
  goalTitle: string;
  desiredOutcome: string;
  profileVersion: number;
  currentLevel: "beginner" | "intermediate" | "advanced";
  weeklyMinutes: number;
  backgroundSummary: string | null;
  nodeKey: string;
  nodeTitle: string;
  nodeBrief: string;
  learningObjective: string;
  rationale: string | null;
  difficulty: number;
  estimatedMinutes: number;
  completionCriteria: string[];
  contentStatus: "not_requested" | "generating" | "ready" | "failed";
}

export interface CardContentGenerationContextRepository {
  findOwnedNodeContext(
    ownerId: string,
    planNodeId: string,
  ): Promise<CardContentGenerationContext | null>;
  hasDefaultModelConnection(ownerId: string): Promise<boolean>;
}

export interface CardContentGenerationAgentRunRequester {
  request(input: {
    ownerId: string;
    goalId: string;
    runType: "card_content_generate";
    targetType: "plan_node";
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

export type CardContentGenerationApplicationErrorCode =
  | "PLAN_NODE_NOT_FOUND"
  | "CARD_CONTENT_ALREADY_AVAILABLE"
  | "CARD_CONTENT_GENERATION_IN_PROGRESS"
  | "DEFAULT_MODEL_CONNECTION_REQUIRED";

export class CardContentGenerationApplicationError extends Error {
  constructor(public readonly code: CardContentGenerationApplicationErrorCode) {
    super(code);
    this.name = "CardContentGenerationApplicationError";
  }
}