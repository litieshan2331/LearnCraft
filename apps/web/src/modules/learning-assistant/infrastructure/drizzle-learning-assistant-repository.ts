/**
 * 学习助手四类 Repository 的 Drizzle 持久化实现。
 *
 * 调用顺序：创建/读取会话 → createQueuedRun 原子分配轮次并写入用户消息和运行
 * → startOwnedRun 领取执行 → appendRunMessages 保存中间消息 → finishOwnedRun 原子提交结果
 * → recordLearningMemory 保存有证据的经历；页面用 listOwnedMessages 恢复，模型用 getRecentContext。
 * 所有写入先锁会话再锁运行，消息序号、幂等和同一会话单运行都在事务内维护。
 */

import { isDeepStrictEqual } from "node:util";

import { and, asc, desc, eq, gt, inArray, max } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "../../../lib/db/client";
import {
  assessmentAnswers,
  assessmentAttempts,
  assessments,
  learningAssistantConversations as conversations,
  learningAssistantMessages as messages,
  learningAssistantRuns as runs,
  learningExperienceMemories as memories,
  learningGoals,
} from "../../../lib/db/schema";

import {
  LEARNING_ASSISTANT_CONTEXT_TURNS,
  LearningAssistantRepositoryError,
  type ConversationRepository,
  type ConversationSnapshot,
  type CreateConversationInput,
  type CreateQueuedRunInput,
  type FinishRunInput,
  type LearningExperienceMemoryRepository,
  type LearningExperienceMemorySnapshot,
  type MessageRepository,
  type MessageSnapshot,
  type PersistRunMessageInput,
  type QueuedRunResult,
  type RecordLearningMemoryInput,
  type RunRepository,
  type RunSnapshot,
  type RunStatistics,
  type UpdateConversationInput,
} from "../domain/learning-assistant";

type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ConversationRecord = typeof conversations.$inferSelect;
type MessageRecord = typeof messages.$inferSelect;
type RunRecord = typeof runs.$inferSelect;
type MemoryRecord = typeof memories.$inferSelect;

const uuid = z.uuid().toLowerCase();
const jsonObject = z.record(z.string(), z.json());
const counter = z.number().int().min(0).max(2_147_483_647);
const conversationStatus = z.enum(["active", "completed", "archived"]);
const conversationStage = z.enum([
  "new", "context_loaded", "diagnosing", "waiting_for_user", "hinting",
  "checking_repair", "mastered", "needs_more_practice", "unresolved",
]);
const runStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
const memoryType = z.enum(["error_pattern", "concept_gap", "learning_preference", "intervention_result"]);
const repairStatus = z.enum(["unverified", "improving", "repaired", "needs_more_practice", "unresolved"]);
const conversationUpdateSchema = z.object({
  status: conversationStatus.optional(),
  stage: conversationStage.optional(),
  stateJson: jsonObject.optional(),
}).strict();
const runStatisticsSchema = z.object({
  modelId: z.string().min(1).max(255).nullable().optional(),
  inputTokens: counter.optional(),
  outputTokens: counter.optional(),
  modelCallCount: counter.optional(),
  toolCallCount: counter.optional(),
  subAgentSummaryJson: z.array(z.json()).optional(),
  skillSummaryJson: z.array(z.json()).optional(),
  tavilySummaryJson: z.array(z.json()).optional(),
  outputSummaryJson: jsonObject.optional(),
}).strict();
const runMessageSchema = z.object({
  id: uuid,
  role: z.enum(["assistant", "tool"]),
  content: z.string().nullable().optional(),
  toolName: z.string().min(1).max(100).nullable().optional(),
  toolCallId: z.string().min(1).max(150).nullable().optional(),
  toolInputJson: jsonObject.optional(),
  toolResultJson: jsonObject.optional(),
  metadataJson: jsonObject.optional(),
}).strict().refine((message) => message.role !== "tool" || Boolean(message.toolName && message.toolCallId));
const evidenceSchema = z.object({
  kind: z.enum(["user_message", "assessment_answer"]),
  sourceId: uuid,
  observation: z.string().trim().min(1),
}).strict();

export class DrizzleLearningAssistantRepository implements
  ConversationRepository, MessageRepository, RunRepository, LearningExperienceMemoryRepository {
  /** 默认复用 Web 数据库；测试可注入隔离连接而不改动全局客户端。 */
  constructor(private readonly databaseProvider: () => Database = getDatabase) {}

  /** 创建允许无目标的会话；目标和来源测评作答必须属于当前用户。 */
  async createConversation(input: CreateConversationInput): Promise<ConversationSnapshot> {
    const value = parseInput(z.object({
      ownerId: uuid,
      goalId: uuid.nullable().optional(),
      sourceAssessmentAnswerId: uuid.nullable().optional(),
    }).strict(), input);
    return this.databaseProvider().transaction(async (transaction) => {
      if (value.goalId) {
        const [goal] = await transaction.select({ id: learningGoals.id }).from(learningGoals)
          .where(and(eq(learningGoals.id, value.goalId), eq(learningGoals.ownerId, value.ownerId)))
          .limit(1);
        if (!goal) throw new LearningAssistantRepositoryError("RELATED_RESOURCE_NOT_FOUND");
      }
      if (value.sourceAssessmentAnswerId) {
        const answer = await findOwnedAssessmentAnswer(transaction, value.ownerId, value.sourceAssessmentAnswerId);
        if (!answer || (value.goalId && answer.goalId !== value.goalId)) {
          throw new LearningAssistantRepositoryError("RELATED_RESOURCE_NOT_FOUND");
        }
      }
      const [record] = await transaction.insert(conversations).values(value).returning();
      if (!record) throw new Error("创建学习助手会话后未返回记录。");
      return toConversationSnapshot(record);
    });
  }

  /** 按所有者读取会话；其他用户的会话与不存在的会话统一返回 null。 */
  async findOwnedConversation(ownerId: string, conversationId: string): Promise<ConversationSnapshot | null> {
    const [record] = await this.databaseProvider().select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.ownerId, ownerId))).limit(1);
    return record ? toConversationSnapshot(record) : null;
  }

  /** 按最近活动时间读取会话列表，默认返回 50 条。 */
  async listOwnedConversations(ownerId: string, limit = 50): Promise<ConversationSnapshot[]> {
    const records = await this.databaseProvider().select().from(conversations)
      .where(eq(conversations.ownerId, ownerId))
      .orderBy(desc(conversations.updatedAt), desc(conversations.id)).limit(validateLimit(limit));
    return records.map(toConversationSnapshot);
  }

  /** 更新会话阶段和已确认事实；存在在途运行时禁止关闭会话。 */
  async updateOwnedConversation(
    ownerId: string, conversationId: string, input: UpdateConversationInput,
  ): Promise<ConversationSnapshot> {
    const value = parseInput(conversationUpdateSchema, input);
    return this.databaseProvider().transaction(async (transaction) => {
      await lockOwnedConversation(transaction, ownerId, conversationId);
      if (value.status && value.status !== "active" && await findActiveRun(transaction, ownerId, conversationId)) {
        throw new LearningAssistantRepositoryError("CONVERSATION_BUSY");
      }
      const [record] = await transaction.update(conversations).set({ ...value, updatedAt: new Date() })
        .where(eq(conversations.id, conversationId)).returning();
      if (!record) throw new Error("更新学习助手会话后未返回记录。");
      return toConversationSnapshot(record);
    });
  }

  /** 一次请求原子创建用户消息和 queued 运行；重复请求不追加消息或增加轮次。 */
  async createQueuedRun(input: CreateQueuedRunInput): Promise<QueuedRunResult> {
    const value = parseInput(z.object({
      ownerId: uuid,
      conversationId: uuid,
      idempotencyKey: z.string().trim().min(1).max(255),
      orchestrationVersion: z.string().trim().min(1).max(100),
      content: z.string().refine((content) => content.trim().length > 0),
      metadataJson: jsonObject.optional(),
      inputSummaryJson: jsonObject.optional(),
    }).strict(), input);

    return this.databaseProvider().transaction(async (transaction) => {
      const conversation = await lockOwnedConversation(transaction, value.ownerId, value.conversationId);
      const [existing] = await transaction.select().from(runs).where(and(
        eq(runs.conversationId, value.conversationId), eq(runs.idempotencyKey, value.idempotencyKey),
      )).limit(1);
      if (existing) {
        const message = await findTriggerMessage(transaction, existing);
        if (existing.ownerId !== value.ownerId || existing.orchestrationVersion !== value.orchestrationVersion
          || message.content !== value.content || !sameJson(message.metadataJson, value.metadataJson ?? {})
          || !sameJson(existing.inputSummaryJson, value.inputSummaryJson ?? {})) {
          throw new LearningAssistantRepositoryError("IDEMPOTENCY_CONFLICT");
        }
        return { run: toRunSnapshot(existing), message: toMessageSnapshot(message), created: false };
      }
      if (conversation.status !== "active") throw new LearningAssistantRepositoryError("CONVERSATION_NOT_ACTIVE");
      if (await findActiveRun(transaction, value.ownerId, value.conversationId)) {
        throw new LearningAssistantRepositoryError("CONVERSATION_BUSY");
      }

      const [position] = await transaction.select({ sequenceNo: max(messages.sequenceNo), turnNo: max(messages.turnNo) })
        .from(messages).where(eq(messages.conversationId, value.conversationId));
      const now = new Date();
      const [message] = await transaction.insert(messages).values({
        conversationId: value.conversationId,
        sequenceNo: (position?.sequenceNo ?? 0) + 1,
        turnNo: (position?.turnNo ?? 0) + 1,
        role: "user",
        content: value.content,
        metadataJson: value.metadataJson ?? {},
        createdAt: now,
      }).returning();
      if (!message) throw new Error("写入学习助手用户消息后未返回记录。");
      const [run] = await transaction.insert(runs).values({
        ownerId: value.ownerId,
        conversationId: value.conversationId,
        triggerMessageId: message.id,
        idempotencyKey: value.idempotencyKey,
        orchestrationVersion: value.orchestrationVersion,
        inputSummaryJson: value.inputSummaryJson ?? {},
      }).returning();
      if (!run) throw new Error("创建学习助手对话运行后未返回记录。");
      await touchConversation(transaction, value.conversationId, now);
      return { run: toRunSnapshot(run), message: toMessageSnapshot(message), created: true };
    });
  }

  /** 按所有者读取运行，用于后续运行状态 API。 */
  async findOwnedRun(ownerId: string, runId: string): Promise<RunSnapshot | null> {
    const [record] = await this.databaseProvider().select().from(runs)
      .where(and(eq(runs.id, runId), eq(runs.ownerId, ownerId))).limit(1);
    return record ? toRunSnapshot(record) : null;
  }

  /** 查找当前会话 queued/running 运行，用于阻止并发推进同一 thread_id。 */
  async findInFlightRun(ownerId: string, conversationId: string): Promise<RunSnapshot | null> {
    const record = await findActiveRun(this.databaseProvider(), ownerId, conversationId);
    return record ? toRunSnapshot(record) : null;
  }

  /** 将 queued 转为 running；重复领取返回 started=false，调用者不得再次执行。 */
  async startOwnedRun(ownerId: string, runId: string): Promise<{ run: RunSnapshot; started: boolean }> {
    return this.databaseProvider().transaction(async (transaction) => {
      const { run, conversation } = await lockOwnedRun(transaction, ownerId, runId);
      if (run.status !== "queued") return { run: toRunSnapshot(run), started: false };
      if (conversation.status !== "active") throw new LearningAssistantRepositoryError("CONVERSATION_NOT_ACTIVE");
      const now = new Date();
      const [record] = await transaction.update(runs).set({ status: "running", startedAt: now, updatedAt: now })
        .where(eq(runs.id, runId)).returning();
      if (!record) throw new Error("领取学习助手对话运行后未返回记录。");
      return { run: toRunSnapshot(record), started: true };
    });
  }

  /** 幂等更新累计调用统计；拒绝负数和将已记录计数回退。 */
  async updateRunningRun(ownerId: string, runId: string, input: RunStatistics): Promise<RunSnapshot> {
    const value = parseInput(runStatisticsSchema, input);
    return this.databaseProvider().transaction(async (transaction) => {
      const { run } = await lockOwnedRun(transaction, ownerId, runId);
      requireRunning(run);
      validateCounters(run, value);
      const [record] = await transaction.update(runs).set({ ...value, updatedAt: new Date() })
        .where(eq(runs.id, runId)).returning();
      if (!record) throw new Error("更新学习助手对话统计后未返回记录。");
      return toRunSnapshot(record);
    });
  }

  /** 保存当前运行的助手和工具消息；消息 ID 重用时检查内容，确保重试不重复落库。 */
  async appendRunMessages(ownerId: string, runId: string, input: PersistRunMessageInput[]): Promise<MessageSnapshot[]> {
    const value = parseInput(z.array(runMessageSchema), input);
    return this.databaseProvider().transaction(async (transaction) => {
      const { run } = await lockOwnedRun(transaction, ownerId, runId);
      requireRunning(run);
      return persistRunMessages(transaction, run, value);
    });
  }

  /** 按全局消息序号读取持久化历史；游标分页不会删除窗口外消息。 */
  async listOwnedMessages(
    ownerId: string, conversationId: string, options: { afterSequenceNo?: number; limit?: number } = {},
  ): Promise<MessageSnapshot[]> {
    const after = parseInput(counter, options.afterSequenceNo ?? 0);
    const records = await this.databaseProvider().select({ message: messages }).from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(conversations.ownerId, ownerId), eq(conversations.id, conversationId), gt(messages.sequenceNo, after)))
      .orderBy(asc(messages.sequenceNo)).limit(validateLimit(options.limit ?? 100));
    return records.map(({ message }) => toMessageSnapshot(message));
  }

  /** 先取最近 20 个轮次，再读取每轮全部消息；不使用 LIMIT 20 截断工具调用链。 */
  async getRecentContext(ownerId: string, conversationId: string): Promise<MessageSnapshot[]> {
    const database = this.databaseProvider();
    const recentTurns = database.selectDistinct({ turnNo: messages.turnNo }).from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.turnNo)).limit(LEARNING_ASSISTANT_CONTEXT_TURNS);
    const records = await database.select({ message: messages }).from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(conversations.ownerId, ownerId), eq(conversations.id, conversationId), inArray(messages.turnNo, recentTurns)))
      .orderBy(asc(messages.sequenceNo));
    return records.map(({ message }) => toMessageSnapshot(message));
  }

  /** 原子保存最终消息、统计、终态及会话阶段；同一结果重试只返回已保存运行。 */
  async finishOwnedRun(input: FinishRunInput): Promise<RunSnapshot> {
    const value = parseInput(runStatisticsSchema.extend({
      ownerId: uuid,
      runId: uuid,
      status: z.enum(["succeeded", "failed", "cancelled"]),
      errorCode: z.string().min(1).max(100).nullable().optional(),
      errorSummary: z.string().nullable().optional(),
      messages: z.array(runMessageSchema).optional(),
      conversation: conversationUpdateSchema.omit({ status: true }).optional(),
    }).strict().refine((result) => result.status !== "failed" || Boolean(result.errorCode)), input);
    const { ownerId, runId, status, messages: finalMessages = [], conversation: update, ...statistics } = value;
    const patch = {
      ...statistics, status,
      errorCode: status === "succeeded" ? null : (value.errorCode ?? null),
      errorSummary: status === "succeeded" ? null : (value.errorSummary ?? null),
    };
    return this.databaseProvider().transaction(async (transaction) => {
      const { run } = await lockOwnedRun(transaction, ownerId, runId);
      if (["succeeded", "failed", "cancelled"].includes(run.status)) {
        if (!matchesPatch(run, patch)) throw new LearningAssistantRepositoryError("IDEMPOTENCY_CONFLICT");
        await persistRunMessages(transaction, run, finalMessages, false);
        return toRunSnapshot(run);
      }
      if (run.status !== "running" && !(status === "cancelled" && run.status === "queued" && finalMessages.length === 0)) {
        throw new LearningAssistantRepositoryError("RUN_NOT_RUNNING");
      }
      validateCounters(run, statistics);
      await persistRunMessages(transaction, run, finalMessages);
      const now = new Date();
      const [record] = await transaction.update(runs).set({ ...patch, finishedAt: now, updatedAt: now })
        .where(eq(runs.id, runId)).returning();
      if (!record) throw new Error("完成学习助手对话运行后未返回记录。");
      await transaction.update(conversations).set({ ...update, updatedAt: now })
        .where(eq(conversations.id, run.conversationId));
      return toRunSnapshot(record);
    });
  }

  /** 保存可追溯学习经历；相同 ID 重试不重复写入，不提供直接编辑接口。 */
  async recordLearningMemory(input: RecordLearningMemoryInput): Promise<{ memory: LearningExperienceMemorySnapshot; created: boolean }> {
    const value = parseInput(z.object({
      id: uuid, ownerId: uuid, conversationId: uuid, sourceRunId: uuid,
      sourceAssessmentAnswerId: uuid.nullable().optional(),
      memoryType,
      knowledgePoint: z.string().min(1).max(200).nullable().optional(),
      errorType: z.string().min(1).max(40).nullable().optional(),
      pattern: z.string().nullable().optional(),
      evidenceJson: z.array(evidenceSchema).min(1),
      interventionJson: jsonObject.optional(),
      repairStatus,
      confidence: z.number().min(0).max(1),
      observedAt: z.date(),
    }).strict(), input);
    return this.databaseProvider().transaction(async (transaction) => {
      const { run } = await lockOwnedRun(transaction, value.ownerId, value.sourceRunId);
      if (run.conversationId !== value.conversationId || !["running", "succeeded"].includes(run.status)) {
        throw new LearningAssistantRepositoryError("INVALID_MEMORY_EVIDENCE");
      }
      if (value.sourceAssessmentAnswerId
        && !await findOwnedAssessmentAnswer(transaction, value.ownerId, value.sourceAssessmentAnswerId)) {
        throw new LearningAssistantRepositoryError("INVALID_MEMORY_EVIDENCE");
      }
      for (const evidence of value.evidenceJson) {
        if (evidence.kind === "assessment_answer") {
          if (!await findOwnedAssessmentAnswer(transaction, value.ownerId, evidence.sourceId)) {
            throw new LearningAssistantRepositoryError("INVALID_MEMORY_EVIDENCE");
          }
        } else {
          const [message] = await transaction.select({ id: messages.id }).from(messages).where(and(
            eq(messages.id, evidence.sourceId), eq(messages.conversationId, value.conversationId), eq(messages.role, "user"),
          )).limit(1);
          if (!message) throw new LearningAssistantRepositoryError("INVALID_MEMORY_EVIDENCE");
        }
      }
      const values = {
        ...value,
        sourceAssessmentAnswerId: value.sourceAssessmentAnswerId ?? null,
        knowledgePoint: value.knowledgePoint ?? null,
        errorType: value.errorType ?? null,
        pattern: value.pattern ?? null,
        interventionJson: value.interventionJson ?? {},
        confidence: value.confidence.toFixed(3),
      };
      const [record] = await transaction.insert(memories).values(values)
        .onConflictDoNothing({ target: memories.id }).returning();
      if (record) return { memory: toMemorySnapshot(record), created: true };
      const [existing] = await transaction.select().from(memories).where(eq(memories.id, value.id)).limit(1);
      if (!existing || !matchesPatch(existing, values)) throw new LearningAssistantRepositoryError("IDEMPOTENCY_CONFLICT");
      return { memory: toMemorySnapshot(existing), created: false };
    });
  }

  /** 按用户和可选知识点读取长期经历；调用方只能通过服务端工具使用这些数据。 */
  async findOwnedMemories(
    ownerId: string, options: { knowledgePoint?: string; limit?: number } = {},
  ): Promise<LearningExperienceMemorySnapshot[]> {
    const records = await this.databaseProvider().select().from(memories).where(and(
      eq(memories.ownerId, ownerId),
      options.knowledgePoint === undefined ? undefined : eq(memories.knowledgePoint, options.knowledgePoint),
    )).orderBy(desc(memories.observedAt), desc(memories.id)).limit(validateLimit(options.limit ?? 50));
    return records.map(toMemorySnapshot);
  }
}

/** 使用结构化合同校验输入，拒绝枚举、计数或 JSON 数据不符合持久化约定的请求。 */
function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new LearningAssistantRepositoryError("INVALID_INPUT");
  return result.data;
}

/** 校验分页限制，防止无界读取；上下文窗口使用独立固定的 20 轮约束。 */
function validateLimit(limit: number): number {
  return parseInput(z.number().int().min(1).max(200), limit);
}

/** 查询测评作答归属，同时返回目标以检查会话目标与来源题的一致性。 */
async function findOwnedAssessmentAnswer(transaction: Transaction, ownerId: string, answerId: string) {
  const [answer] = await transaction.select({ id: assessmentAnswers.id, goalId: assessments.goalId })
    .from(assessmentAnswers)
    .innerJoin(assessmentAttempts, eq(assessmentAttempts.id, assessmentAnswers.attemptId))
    .innerJoin(assessments, eq(assessments.id, assessmentAttempts.assessmentId))
    .where(and(eq(assessmentAnswers.id, answerId), eq(assessmentAttempts.ownerId, ownerId), eq(assessments.ownerId, ownerId)))
    .limit(1);
  return answer ?? null;
}

/** 锁定拥有的会话，统一串行化轮次分配、运行状态和消息写入。 */
async function lockOwnedConversation(transaction: Transaction, ownerId: string, conversationId: string) {
  const [conversation] = await transaction.select().from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.ownerId, ownerId))).limit(1).for("update");
  if (!conversation) throw new LearningAssistantRepositoryError("CONVERSATION_NOT_FOUND");
  return conversation;
}

/** 先确认运行归属，再按统一顺序锁会话和运行，避免与消息创建发生死锁。 */
async function lockOwnedRun(transaction: Transaction, ownerId: string, runId: string) {
  const [candidate] = await transaction.select({ conversationId: runs.conversationId }).from(runs)
    .where(and(eq(runs.id, runId), eq(runs.ownerId, ownerId))).limit(1);
  if (!candidate) throw new LearningAssistantRepositoryError("RUN_NOT_FOUND");
  const conversation = await lockOwnedConversation(transaction, ownerId, candidate.conversationId);
  const [run] = await transaction.select().from(runs)
    .where(and(eq(runs.id, runId), eq(runs.ownerId, ownerId))).limit(1).for("update");
  if (!run) throw new LearningAssistantRepositoryError("RUN_NOT_FOUND");
  return { run, conversation };
}

/** 获取同一用户会话的在途运行，创建运行时在会话锁保护下调用。 */
async function findActiveRun(database: Database | Transaction, ownerId: string, conversationId: string) {
  const [run] = await database.select().from(runs).where(and(
    eq(runs.ownerId, ownerId), eq(runs.conversationId, conversationId), inArray(runs.status, ["queued", "running"]),
  )).orderBy(desc(runs.createdAt)).limit(1);
  return run ?? null;
}

/** 读取触发用户消息，确保后续助手和工具消息始终归入该次运行的轮次。 */
async function findTriggerMessage(transaction: Transaction, run: RunRecord): Promise<MessageRecord> {
  if (!run.triggerMessageId) throw new Error("学习助手运行缺少触发消息。");
  const [message] = await transaction.select().from(messages).where(and(
    eq(messages.id, run.triggerMessageId), eq(messages.conversationId, run.conversationId), eq(messages.role, "user"),
  )).limit(1);
  if (!message) throw new Error("学习助手运行的触发用户消息不存在。");
  return message;
}

/** 拒绝向未领取或已结束的运行写入新的消息和统计。 */
function requireRunning(run: RunRecord): void {
  if (run.status !== "running") throw new LearningAssistantRepositoryError("RUN_NOT_RUNNING");
}

/** 累计快照只允许保持或增加已记录计数，避免旧重试覆盖新的统计值。 */
function validateCounters(run: RunRecord, input: RunStatistics): void {
  for (const key of ["inputTokens", "outputTokens", "modelCallCount", "toolCallCount"] as const) {
    if (input[key] !== undefined && input[key] < run[key]) throw new LearningAssistantRepositoryError("INVALID_INPUT");
  }
}

/** 在会话锁下追加或返回已有消息，批量失败时整批回滚。 */
async function persistRunMessages(
  transaction: Transaction, run: RunRecord, input: PersistRunMessageInput[], allowInsert = true,
): Promise<MessageSnapshot[]> {
  if (input.length === 0) return [];
  const trigger = await findTriggerMessage(transaction, run);
  const [position] = await transaction.select({ sequenceNo: max(messages.sequenceNo) }).from(messages)
    .where(eq(messages.conversationId, run.conversationId));
  let sequenceNo = position?.sequenceNo ?? 0;
  const result: MessageSnapshot[] = [];
  let inserted = false;
  const now = new Date();
  for (const message of input) {
    const values = {
      id: message.id,
      conversationId: run.conversationId,
      turnNo: trigger.turnNo,
      role: message.role,
      content: message.content ?? null,
      toolName: message.toolName ?? null,
      toolCallId: message.toolCallId ?? null,
      toolInputJson: message.toolInputJson ?? {},
      toolResultJson: message.toolResultJson ?? {},
      metadataJson: message.metadataJson ?? {},
    };
    const [existing] = await transaction.select().from(messages).where(eq(messages.id, message.id)).limit(1);
    if (existing) {
      if (!matchesPatch(existing, values)) throw new LearningAssistantRepositoryError("IDEMPOTENCY_CONFLICT");
      result.push(toMessageSnapshot(existing));
      continue;
    }
    if (!allowInsert) throw new LearningAssistantRepositoryError("IDEMPOTENCY_CONFLICT");
    const [record] = await transaction.insert(messages).values({ ...values, sequenceNo: ++sequenceNo, createdAt: now }).returning();
    if (!record) throw new Error("写入学习助手消息后未返回记录。");
    inserted = true;
    result.push(toMessageSnapshot(record));
  }
  if (inserted) await touchConversation(transaction, run.conversationId, now);
  return result;
}

/** 随消息提交更新会话最近活动时间，使会话列表和刷新恢复得到一致状态。 */
async function touchConversation(transaction: Transaction, conversationId: string, now: Date): Promise<void> {
  await transaction.update(conversations).set({ lastMessageAt: now, updatedAt: now }).where(eq(conversations.id, conversationId));
}

/** 比较数据库记录与本次提交字段，日期和 JSON 按持久化表示比较。 */
function matchesPatch(record: object, patch: object): boolean {
  const saved = record as Record<string, unknown>;
  return Object.entries(patch).every(([key, value]) => value === undefined || sameJson(saved[key], value));
}

/** 使用结构化比较忽略 JSON 对象键顺序，同时匹配 PostgreSQL JSONB 的序列化结果。 */
function sameJson(left: unknown, right: unknown): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
  } catch {
    throw new LearningAssistantRepositoryError("INVALID_INPUT");
  }
}

/** 将持久化会话转换为领域快照，并检查枚举和会话记忆结构。 */
function toConversationSnapshot(record: ConversationRecord): ConversationSnapshot {
  return { ...record, status: conversationStatus.parse(record.status), stage: conversationStage.parse(record.stage), stateJson: jsonObject.parse(record.stateJson) };
}

/** 转换消息快照，保留工具参数、结果及元数据用于恢复和审计。 */
function toMessageSnapshot(record: MessageRecord): MessageSnapshot {
  return {
    ...record, role: z.enum(["user", "assistant", "tool"]).parse(record.role),
    toolInputJson: jsonObject.parse(record.toolInputJson), toolResultJson: jsonObject.parse(record.toolResultJson),
    metadataJson: jsonObject.parse(record.metadataJson),
  };
}

/** 转换运行快照，保留结构化调用摘要和实际 token 计数。 */
function toRunSnapshot(record: RunRecord): RunSnapshot {
  return {
    ...record, status: runStatus.parse(record.status),
    inputSummaryJson: jsonObject.parse(record.inputSummaryJson), outputSummaryJson: jsonObject.parse(record.outputSummaryJson),
    subAgentSummaryJson: z.array(z.unknown()).parse(record.subAgentSummaryJson),
    skillSummaryJson: z.array(z.unknown()).parse(record.skillSummaryJson),
    tavilySummaryJson: z.array(z.unknown()).parse(record.tavilySummaryJson),
  };
}

/** 转换学习经历快照，numeric 置信度在领域中使用 number。 */
function toMemorySnapshot(record: MemoryRecord): LearningExperienceMemorySnapshot {
  return {
    ...record, memoryType: memoryType.parse(record.memoryType), repairStatus: repairStatus.parse(record.repairStatus),
    confidence: Number(record.confidence), evidenceJson: z.array(evidenceSchema).parse(record.evidenceJson),
    interventionJson: jsonObject.parse(record.interventionJson),
  };
}
