/**
 * AgentRun 限界上下文的领域模型与端口。
 *
 * 导出：
 * - AgentRunRepository：创建、读取和取消 AgentRun 的持久化端口。
 * - AgentRunSnapshot：可安全返回给任务所有者的运行状态快照。
 * - AgentRunApplicationError：供应用层映射稳定业务错误码的错误类型。
 * - getAgentRunCancellationDecision：判断任务是否允许协作式取消。
 */

export const AGENT_RUN_TYPES = [
  "assessment_generate",
  "plan_generate",
  "card_content_generate",
  "posttest_generate",
  "adaptation",
] as const;

export const AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;

export type AgentRunType = (typeof AGENT_RUN_TYPES)[number];
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export interface AgentRunErrorSnapshot {
  code: string;
  message: string;
  retryable: boolean;
}

export interface AgentRunAssessmentResultSnapshot {
  assessmentId: string;
  questionCount: number;
}

export interface AgentRunPlanResultSnapshot {
  learningPlanId: string;
  nodeCount: number;
}

export interface AgentRunSnapshot {
  id: string;
  runType: AgentRunType;
  status: AgentRunStatus;
  targetType: string;
  targetId: string;
  modelConnectionId: string | null;
  requestedModelId: string | null;
  retryCount: number;
  traceId: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  assessmentResult?: AgentRunAssessmentResultSnapshot;
  planResult?: AgentRunPlanResultSnapshot;
  error?: AgentRunErrorSnapshot;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentRunProductionInput {
  ownerId: string;
  goalId: string;
  runType: AgentRunType;
  targetType: string;
  targetId: string;
  idempotencyKey: string;
  graphVersion: string;
  promptVersion?: string | null;
  inputSchemaVersion: string;
  outputSchemaVersion?: string | null;
  requestedModelProfile: string;
  modelConnectionId?: string | null;
  requestedModelId?: string | null;
  inputSummaryJson?: Record<string, unknown>;
  traceId: string;
}

export interface AgentRunProductionResult {
  agentRun: AgentRunSnapshot;
  created: boolean;
}

export type AgentRunCancellationDecision = "cancel" | "already_cancelled" | "not_cancellable";

export interface AgentRunCancellationResult {
  decision: AgentRunCancellationDecision;
  agentRun: AgentRunSnapshot | null;
}

/** 按目标（业务对象）查找在途任务：同一目标只允许一个 queued/running 任务。 */
export interface AgentRunInFlightQuery {
  ownerId: string;
  runType: AgentRunType;
  targetType: string;
  targetId: string;
}

export interface AgentRunRepository {
  create(input: AgentRunProductionInput): Promise<AgentRunProductionResult>;
  findOwnedRun(ownerId: string, agentRunId: string): Promise<AgentRunSnapshot | null>;
  findInFlightRun(query: AgentRunInFlightQuery): Promise<AgentRunSnapshot | null>;
  cancelOwnedRun(ownerId: string, agentRunId: string): Promise<AgentRunCancellationResult>;
}

export type AgentRunApplicationErrorCode =
  | "AGENT_RUN_NOT_FOUND"
  | "AGENT_RUN_NOT_CANCELLABLE"
  | "IDEMPOTENCY_CONFLICT";

export class AgentRunApplicationError extends Error {
  constructor(public readonly code: AgentRunApplicationErrorCode) {
    super(code);
    this.name = "AgentRunApplicationError";
  }
}

export function getAgentRunCancellationDecision(status: AgentRunStatus): AgentRunCancellationDecision {
  if (status === "queued" || status === "running") {
    return "cancel";
  }

  if (status === "cancelled") {
    return "already_cancelled";
  }

  return "not_cancellable";
}

export function isAgentRunType(value: string): value is AgentRunType {
  return (AGENT_RUN_TYPES as readonly string[]).includes(value);
}

export function isAgentRunStatus(value: string): value is AgentRunStatus {
  return (AGENT_RUN_STATUSES as readonly string[]).includes(value);
}
