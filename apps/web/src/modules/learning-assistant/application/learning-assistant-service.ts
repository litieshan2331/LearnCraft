/**
 * 学习助手应用服务，编排会话、消息和对话运行的 HTTP 用例。
 *
 * 调用顺序：Route Handler 校验请求 → LearningAssistantService 校验所有权并调用
 * Repository → 返回应用结果；本服务只负责持久化编排，不执行模型、队列或 Agent。
 */

import {
  LearningAssistantRepositoryError,
  type ConversationRepository,
  type ConversationSnapshot,
  type CreateConversationInput,
  type MessageRepository,
  type MessageSnapshot,
  type QueuedRunResult,
  type RunRepository,
  type RunSnapshot,
} from "../domain/learning-assistant";

type LearningAssistantRepository =
  Pick<ConversationRepository, "createConversation" | "findOwnedConversation" | "listOwnedConversations">
  & Pick<MessageRepository, "listOwnedMessages">
  & Pick<RunRepository, "createQueuedRun" | "findOwnedRun" | "findInFlightRun">;

export const LEARNING_ASSISTANT_ORCHESTRATION_VERSION = "learning-assistant-mvp-v1";
export const LEARNING_ASSISTANT_MESSAGE_PAGE_LIMIT = 100;

export type LearningAssistantApplicationErrorCode =
  | "CONVERSATION_NOT_FOUND"
  | "RELATED_RESOURCE_NOT_FOUND"
  | "CONVERSATION_NOT_ACTIVE"
  | "CONVERSATION_BUSY"
  | "RUN_NOT_FOUND"
  | "INVALID_INPUT"
  | "IDEMPOTENCY_CONFLICT";

/** 应用层稳定错误，供 HTTP 适配器转换为状态码和公开消息。 */
export class LearningAssistantApplicationError extends Error {
  /** 构造稳定应用错误，HTTP 层只公开错误码对应的安全文案。 */
  constructor(public readonly code: LearningAssistantApplicationErrorCode) {
    super(code);
    this.name = "LearningAssistantApplicationError";
  }
}

export interface SendLearningAssistantMessageInput {
  ownerId: string;
  conversationId: string;
  idempotencyKey: string;
  content: string;
}

export interface LearningAssistantConversationDetail {
  conversation: ConversationSnapshot;
  activeRun: RunSnapshot | null;
}

export interface ListLearningAssistantMessagesResult {
  items: MessageSnapshot[];
  nextAfterSequenceNo: number | null;
}

export class LearningAssistantService {
  /** 注入本阶段用例需要的领域端口，不依赖具体数据库实现。 */
  constructor(private readonly repository: LearningAssistantRepository) {}

  /** 创建学习助手会话；目标和来源错题为空的规则由 Repository 校验。 */
  async createConversation(input: CreateConversationInput): Promise<ConversationSnapshot> {
    try {
      return await this.repository.createConversation(input);
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  /** 返回当前用户最近更新的会话列表。 */
  async listConversations(ownerId: string, limit = 50): Promise<ConversationSnapshot[]> {
    try {
      return await this.repository.listOwnedConversations(ownerId, limit);
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  /** 读取当前用户拥有的单个会话，不泄露其他用户资源是否存在。 */
  async getConversation(ownerId: string, conversationId: string): Promise<LearningAssistantConversationDetail> {
    try {
      const conversation = await this.requireOwnedConversation(ownerId, conversationId);
      const activeRun = await this.repository.findInFlightRun(ownerId, conversationId);
      return { conversation, activeRun };
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  /** 原子保存用户消息并创建 queued 运行；模型执行由后续队列消费者负责。 */
  async sendMessage(input: SendLearningAssistantMessageInput): Promise<QueuedRunResult> {
    try {
      return await this.repository.createQueuedRun({
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        idempotencyKey: input.idempotencyKey,
        orchestrationVersion: LEARNING_ASSISTANT_ORCHESTRATION_VERSION,
        content: input.content,
      });
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  /** 按消息序号游标读取全部历史；仅应用层分页，不会把旧消息从数据库删除。 */
  async listMessages(
    ownerId: string,
    conversationId: string,
    options: { afterSequenceNo?: number; limit?: number } = {},
  ): Promise<ListLearningAssistantMessagesResult> {
    try {
      await this.requireOwnedConversation(ownerId, conversationId);
      const limit = options.limit ?? 100;
      const afterSequenceNo = options.afterSequenceNo ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > LEARNING_ASSISTANT_MESSAGE_PAGE_LIMIT
        || !Number.isInteger(afterSequenceNo) || afterSequenceNo < 0 || afterSequenceNo > 2_147_483_647) {
        throw new LearningAssistantApplicationError("INVALID_INPUT");
      }
      const messages = await this.repository.listOwnedMessages(ownerId, conversationId, {
        afterSequenceNo,
        limit: limit + 1,
      });
      const hasMore = messages.length > limit;
      const items = hasMore ? messages.slice(0, limit) : messages;
      return {
        items,
        nextAfterSequenceNo: hasMore ? items.at(-1)?.sequenceNo ?? null : null,
      };
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  /** 查询当前用户拥有的对话运行状态；运行详情不触发模型执行。 */
  async getRun(ownerId: string, runId: string): Promise<RunSnapshot> {
    try {
      const run = await this.repository.findOwnedRun(ownerId, runId);
      if (!run) {
        throw new LearningAssistantApplicationError("RUN_NOT_FOUND");
      }
      return run;
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  /** 确认会话归属后才允许读取消息或查询在途运行。 */
  private async requireOwnedConversation(ownerId: string, conversationId: string): Promise<ConversationSnapshot> {
    const conversation = await this.repository.findOwnedConversation(ownerId, conversationId);
    if (!conversation) throw new LearningAssistantApplicationError("CONVERSATION_NOT_FOUND");
    return conversation;
  }
}

/** 将 Repository 稳定错误转换为应用层错误，隐藏底层存储实现。 */
function mapRepositoryError(error: unknown): unknown {
  if (error instanceof LearningAssistantApplicationError) {
    return error;
  }
  if (!(error instanceof LearningAssistantRepositoryError)) {
    return error;
  }
  switch (error.code) {
    case "RELATED_RESOURCE_NOT_FOUND":
      return new LearningAssistantApplicationError("RELATED_RESOURCE_NOT_FOUND");
    case "CONVERSATION_NOT_ACTIVE":
      return new LearningAssistantApplicationError("CONVERSATION_NOT_ACTIVE");
    case "CONVERSATION_BUSY":
      return new LearningAssistantApplicationError("CONVERSATION_BUSY");
    case "IDEMPOTENCY_CONFLICT":
      return new LearningAssistantApplicationError("IDEMPOTENCY_CONFLICT");
    case "INVALID_INPUT":
      return new LearningAssistantApplicationError("INVALID_INPUT");
    case "CONVERSATION_NOT_FOUND":
      return new LearningAssistantApplicationError("CONVERSATION_NOT_FOUND");
    case "RUN_NOT_FOUND":
      return new LearningAssistantApplicationError("RUN_NOT_FOUND");
    case "RUN_NOT_RUNNING":
    case "INVALID_MEMORY_EVIDENCE":
      return new LearningAssistantApplicationError("INVALID_INPUT");
  }
}
