/**
 * 学习助手的领域数据与四类持久化端口。
 *
 * 调用顺序：ConversationRepository 创建会话 → RunRepository 原子写入用户消息和运行
 * → MessageRepository 保存助手/工具消息、读取历史和最近 20 轮 → RunRepository 完成运行
 * → LearningExperienceMemoryRepository 记录有来源证据的学习经历。
 * 这些端口只供服务端应用层使用，学习经历记忆不提供用户编辑端口。
 */

export type ConversationStatus = "active" | "completed" | "archived";
export type ConversationStage =
  | "new" | "context_loaded" | "diagnosing" | "waiting_for_user" | "hinting"
  | "checking_repair" | "mastered" | "needs_more_practice" | "unresolved";
export type MessageRole = "user" | "assistant" | "tool";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type MemoryType = "error_pattern" | "concept_gap" | "learning_preference" | "intervention_result";
export type RepairStatus = "unverified" | "improving" | "repaired" | "needs_more_practice" | "unresolved";

export const LEARNING_ASSISTANT_CONTEXT_TURNS = 20;

export interface ConversationSnapshot {
  id: string;
  ownerId: string;
  goalId: string | null;
  sourceAssessmentAnswerId: string | null;
  status: ConversationStatus;
  stage: ConversationStage;
  stateJson: Record<string, unknown>;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageSnapshot {
  id: string;
  conversationId: string;
  sequenceNo: number;
  turnNo: number;
  role: MessageRole;
  content: string | null;
  toolName: string | null;
  toolCallId: string | null;
  toolInputJson: Record<string, unknown>;
  toolResultJson: Record<string, unknown>;
  metadataJson: Record<string, unknown>;
  createdAt: Date;
}

export interface RunStatistics {
  modelId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  modelCallCount?: number;
  toolCallCount?: number;
  subAgentSummaryJson?: unknown[];
  skillSummaryJson?: unknown[];
  tavilySummaryJson?: unknown[];
  outputSummaryJson?: Record<string, unknown>;
}

export interface RunSnapshot extends Required<RunStatistics> {
  id: string;
  conversationId: string;
  ownerId: string;
  triggerMessageId: string | null;
  idempotencyKey: string;
  status: RunStatus;
  orchestrationVersion: string;
  inputSummaryJson: Record<string, unknown>;
  errorCode: string | null;
  errorSummary: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 学习经历的证据必须引用当前会话用户消息或当前用户的测评作答。 */
export interface MemoryEvidence {
  kind: "user_message" | "assessment_answer";
  sourceId: string;
  observation: string;
}

export interface LearningExperienceMemorySnapshot {
  id: string;
  ownerId: string;
  conversationId: string | null;
  sourceAssessmentAnswerId: string | null;
  sourceRunId: string | null;
  memoryType: MemoryType;
  knowledgePoint: string | null;
  errorType: string | null;
  pattern: string | null;
  evidenceJson: MemoryEvidence[];
  interventionJson: Record<string, unknown>;
  repairStatus: RepairStatus;
  confidence: number;
  observedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateConversationInput {
  ownerId: string;
  goalId?: string | null;
  sourceAssessmentAnswerId?: string | null;
}

export interface UpdateConversationInput {
  status?: ConversationStatus;
  stage?: ConversationStage;
  stateJson?: Record<string, unknown>;
}

export interface CreateQueuedRunInput {
  ownerId: string;
  conversationId: string;
  idempotencyKey: string;
  orchestrationVersion: string;
  content: string;
  metadataJson?: Record<string, unknown>;
  inputSummaryJson?: Record<string, unknown>;
}

export interface QueuedRunResult {
  run: RunSnapshot;
  message: MessageSnapshot;
  created: boolean;
}

/** id 在首次写入前生成并在重试时复用；assistant 的工具调用可保存在 metadataJson。 */
export interface PersistRunMessageInput {
  id: string;
  role: "assistant" | "tool";
  content?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  toolInputJson?: Record<string, unknown>;
  toolResultJson?: Record<string, unknown>;
  metadataJson?: Record<string, unknown>;
}

export interface FinishRunInput extends RunStatistics {
  ownerId: string;
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
  errorCode?: string | null;
  errorSummary?: string | null;
  messages?: PersistRunMessageInput[];
  conversation?: Pick<UpdateConversationInput, "stage" | "stateJson">;
}

/** 写入时必须关联当前会话和来源运行；关联字段可在业务对象删除后变为空。 */
export interface RecordLearningMemoryInput {
  id: string;
  ownerId: string;
  conversationId: string;
  sourceRunId: string;
  sourceAssessmentAnswerId?: string | null;
  memoryType: MemoryType;
  knowledgePoint?: string | null;
  errorType?: string | null;
  pattern?: string | null;
  evidenceJson: MemoryEvidence[];
  interventionJson?: Record<string, unknown>;
  repairStatus: RepairStatus;
  confidence: number;
  observedAt: Date;
}

export interface ConversationRepository {
  createConversation(input: CreateConversationInput): Promise<ConversationSnapshot>;
  findOwnedConversation(ownerId: string, conversationId: string): Promise<ConversationSnapshot | null>;
  listOwnedConversations(ownerId: string, limit?: number): Promise<ConversationSnapshot[]>;
  updateOwnedConversation(ownerId: string, conversationId: string, input: UpdateConversationInput): Promise<ConversationSnapshot>;
}

export interface MessageRepository {
  appendRunMessages(ownerId: string, runId: string, messages: PersistRunMessageInput[]): Promise<MessageSnapshot[]>;
  listOwnedMessages(ownerId: string, conversationId: string, options?: { afterSequenceNo?: number; limit?: number }): Promise<MessageSnapshot[]>;
  /** 保留最近 20 个 turn_no 的全部消息，包含当前轮；旧消息只退出上下文，不从数据库删除。 */
  getRecentContext(ownerId: string, conversationId: string): Promise<MessageSnapshot[]>;
}

export interface RunRepository {
  createQueuedRun(input: CreateQueuedRunInput): Promise<QueuedRunResult>;
  findOwnedRun(ownerId: string, runId: string): Promise<RunSnapshot | null>;
  findInFlightRun(ownerId: string, conversationId: string): Promise<RunSnapshot | null>;
  startOwnedRun(ownerId: string, runId: string): Promise<{ run: RunSnapshot; started: boolean }>;
  /** 统计采用累计快照写入，重复提交不重复计数。 */
  updateRunningRun(ownerId: string, runId: string, input: RunStatistics): Promise<RunSnapshot>;
  /** 最终消息、运行状态、会话阶段在一个事务中提交。 */
  finishOwnedRun(input: FinishRunInput): Promise<RunSnapshot>;
}

export interface LearningExperienceMemoryRepository {
  recordLearningMemory(input: RecordLearningMemoryInput): Promise<{ memory: LearningExperienceMemorySnapshot; created: boolean }>;
  findOwnedMemories(ownerId: string, options?: { knowledgePoint?: string; limit?: number }): Promise<LearningExperienceMemorySnapshot[]>;
}

export type LearningAssistantRepositoryErrorCode =
  | "CONVERSATION_NOT_FOUND" | "CONVERSATION_NOT_ACTIVE" | "CONVERSATION_BUSY"
  | "RELATED_RESOURCE_NOT_FOUND" | "RUN_NOT_FOUND" | "RUN_NOT_RUNNING"
  | "INVALID_INPUT" | "INVALID_MEMORY_EVIDENCE" | "IDEMPOTENCY_CONFLICT";

export class LearningAssistantRepositoryError extends Error {
  /** 使用稳定错误码表示不可访问的资源、非法输入或幂等冲突，供后续应用层映射响应。 */
  constructor(public readonly code: LearningAssistantRepositoryErrorCode) {
    super(code);
    this.name = "LearningAssistantRepositoryError";
  }
}
