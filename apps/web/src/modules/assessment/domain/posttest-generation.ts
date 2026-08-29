/**
 * 节点后测生成用例的领域模型与持久化端口。
 *
 * 导出：
 * - PosttestGenerationRequest：节点后测生成请求。
 * - PosttestGenerationContext：节点与唯一成功内容的上下文快照。
 * - PosttestGenerationContextRepository：读取节点后测所需的归属和内容状态。
 * - PosttestGenerationApplicationError：映射稳定的业务错误码。
 */

import type { AgentRunProductionResult } from "@/modules/agent-run/domain/agent-run";

export const POSTTEST_GENERATION_DIFFICULTIES = ["normal", "hard"] as const;

export type PosttestGenerationDifficulty = (typeof POSTTEST_GENERATION_DIFFICULTIES)[number];

export interface PosttestGenerationRequest {
  ownerId: string;
  planNodeId: string;
  questionCount: number;
  difficulty: PosttestGenerationDifficulty;
  idempotencyKey: string;
}

export interface PosttestGenerationContext {
  goalId: string;
  planNodeId: string;
  cardContentId: string | null;
  topic: string;
}

export interface PosttestGenerationContextRepository {
  findOwnedNodeContext(
    ownerId: string,
    planNodeId: string,
  ): Promise<PosttestGenerationContext | null>;
  hasDefaultModelConnection(ownerId: string): Promise<boolean>;
}

export interface PosttestGenerationAgentRunRequester {
  request(input: {
    ownerId: string;
    goalId: string;
    runType: "posttest_generate";
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

export type PosttestGenerationApplicationErrorCode =
  | "PLAN_NODE_NOT_FOUND"
  | "CARD_CONTENT_NOT_READY"
  | "DEFAULT_MODEL_CONNECTION_REQUIRED";

export class PosttestGenerationApplicationError extends Error {
  constructor(public readonly code: PosttestGenerationApplicationErrorCode) {
    super(code);
    this.name = "PosttestGenerationApplicationError";
  }
}