/**
 * 学习助手 Repository 的 PostgreSQL 集成测试。
 *
 * 调用顺序：beforeAll 创建独立用户和测评来源 → beforeEach 创建会话 → 测试执行 Repository
 * → afterAll 删除本测试生成的用户数据并关闭连接。仅显式设置 LEARNING_ASSISTANT_TEST_DATABASE_URL 时执行，
 * 不自动读取生产配置，不使用模型、Redis 或外部工具服务。
 */

import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../../src/lib/db/schema";
import type { CreateQueuedRunInput, FinishRunInput, RecordLearningMemoryInput } from "../../src/modules/learning-assistant/domain/learning-assistant";
import { DrizzleLearningAssistantRepository } from "../../src/modules/learning-assistant/infrastructure/drizzle-learning-assistant-repository";

const databaseUrl = process.env.LEARNING_ASSISTANT_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("学习助手 PostgreSQL Repository", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5_000 });
  const database = drizzle({ client: pool, schema });
  const repository = new DrizzleLearningAssistantRepository(() => database);
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const ownerIds = [ownerId, otherOwnerId];
  const goalIds = [randomUUID(), randomUUID()];
  const assessmentIds = [randomUUID(), randomUUID()];
  const attemptIds = [randomUUID(), randomUUID()];
  const itemIds = [randomUUID(), randomUUID()];
  const answerIds = [randomUUID(), randomUUID()];
  let conversationId: string;

  // 只创建本测试独立的数据，避免修改已有用户、错题和会话。
  beforeAll(async () => {
    for (let index = 0; index < ownerIds.length; index++) {
      await database.insert(schema.users).values({
        id: ownerIds[index], email: `assistant-repository-${ownerIds[index]}@example.invalid`,
        displayName: "学习助手 Repository 测试", passwordHash: "integration-test-only",
      });
      await database.insert(schema.learningGoals).values({
        id: goalIds[index], ownerId: ownerIds[index], topic: "TypeScript", title: "集成测试",
        description: "隔离测试数据", desiredOutcome: "验证持久化", profileVersion: 1,
      });
      await database.insert(schema.assessments).values({
        id: assessmentIds[index], ownerId: ownerIds[index], goalId: goalIds[index],
        kind: "diagnostic", requestedQuestionCount: 10, schemaVersion: "test.v1", status: "graded",
      });
      await database.insert(schema.assessmentItems).values({
        id: itemIds[index], assessmentId: assessmentIds[index], ordinal: 1, itemType: "single_choice",
        prompt: "哪个选项正确？", optionsJson: [{ key: "A" }, { key: "B" }], answerKeyJson: { key: "A" },
        gradingMode: "deterministic", explanation: "测试题", maxScore: "1", schemaVersion: "test.v1",
      });
      await database.insert(schema.assessmentAttempts).values({
        id: attemptIds[index], ownerId: ownerIds[index], assessmentId: assessmentIds[index], attemptNo: 1, status: "graded",
      });
      await database.insert(schema.assessmentAnswers).values({
        id: answerIds[index], attemptId: attemptIds[index], assessmentItemId: itemIds[index],
        answerJson: { key: "B" }, isCorrect: false,
      });
    }
  });

  // 每个用例使用新的会话，轮次与状态彼此隔离。
  beforeEach(async () => {
    conversationId = (await repository.createConversation({ ownerId })).id;
  });

  // 仅清理明确属于本测试随机用户的记录；关联运行、消息和记忆由会话外键级联清理。
  afterAll(async () => {
    try {
      await database.delete(schema.learningAssistantConversations).where(inArray(schema.learningAssistantConversations.ownerId, ownerIds));
      await database.delete(schema.assessmentAnswers).where(inArray(schema.assessmentAnswers.id, answerIds));
      await database.delete(schema.assessmentAttempts).where(inArray(schema.assessmentAttempts.id, attemptIds));
      await database.delete(schema.assessments).where(inArray(schema.assessments.id, assessmentIds));
      await database.delete(schema.users).where(inArray(schema.users.id, ownerIds));
    } finally {
      await pool.end();
    }
  });

  /** 生成有稳定幂等键的用户消息请求，按用例覆盖必要字段。 */
  function createRequest(overrides: Partial<CreateQueuedRunInput> = {}): CreateQueuedRunInput {
    return { ownerId, conversationId, idempotencyKey: randomUUID(), orchestrationVersion: "test.v1", content: "请帮我理解作用域", ...overrides };
  }

  /** 建立正在运行的对话轮次，返回消息、运行和原始请求供重试验证。 */
  async function startRun() {
    const request = createRequest();
    const result = await repository.createQueuedRun(request);
    await repository.startOwnedRun(ownerId, result.run.id);
    return { ...result, request };
  }

  it("支持空目标并校验目标、测评作答和会话归属", async () => {
    const conversation = await repository.findOwnedConversation(ownerId, conversationId);
    expect(conversation).toMatchObject({ goalId: null, sourceAssessmentAnswerId: null, status: "active", stage: "new" });
    const sourced = await repository.createConversation({ ownerId, goalId: goalIds[0], sourceAssessmentAnswerId: answerIds[0] });
    expect(sourced.sourceAssessmentAnswerId).toBe(answerIds[0]);
    await expect(repository.createConversation({ ownerId, goalId: goalIds[1] })).rejects.toMatchObject({ code: "RELATED_RESOURCE_NOT_FOUND" });
    await expect(repository.createConversation({ ownerId, sourceAssessmentAnswerId: answerIds[1] })).rejects.toMatchObject({ code: "RELATED_RESOURCE_NOT_FOUND" });
    await expect(repository.findOwnedConversation(otherOwnerId, conversationId)).resolves.toBeNull();
    await expect(repository.updateOwnedConversation(otherOwnerId, conversationId, { stage: "diagnosing" })).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    await repository.updateOwnedConversation(ownerId, conversationId, { stage: "diagnosing", stateJson: { known: "作用域" } });
    expect(await repository.listOwnedConversations(ownerId)).toEqual(expect.arrayContaining([expect.objectContaining({ id: conversationId, stage: "diagnosing" })]));
  });

  it("同一幂等请求并发提交只创建一条用户消息和一次运行", async () => {
    const request = createRequest({ metadataJson: { a: 1, b: 2 } });
    const results = await Promise.all(Array.from({ length: 6 }, () => repository.createQueuedRun(request)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
    expect(await repository.listOwnedMessages(ownerId, conversationId)).toHaveLength(1);
    await expect(repository.createQueuedRun({ ...request, metadataJson: { b: 2, a: 1 } })).resolves.toMatchObject({ created: false });
    await expect(repository.createQueuedRun({ ...request, content: "不同问题" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const [record] = await database.select().from(schema.learningAssistantRuns).where(eq(schema.learningAssistantRuns.id, results[0].run.id));
    expect(record.triggerMessageId).toBe(results[0].message.id);
  });

  it("运行在途时阻止新一轮和关闭会话，重复领取不再次执行", async () => {
    const competing = await Promise.allSettled(Array.from({ length: 6 }, () => repository.createQueuedRun(createRequest())));
    const successful = competing.filter((result) => result.status === "fulfilled");
    expect(successful).toHaveLength(1);
    for (const result of competing) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "CONVERSATION_BUSY" });
    }
    const { run } = successful[0].value;
    await expect(repository.createQueuedRun(createRequest())).rejects.toMatchObject({ code: "CONVERSATION_BUSY" });
    await expect(repository.updateOwnedConversation(ownerId, conversationId, { status: "archived" })).rejects.toMatchObject({ code: "CONVERSATION_BUSY" });
    const starts = await Promise.all([repository.startOwnedRun(ownerId, run.id), repository.startOwnedRun(ownerId, run.id)]);
    expect(starts.filter((result) => result.started)).toHaveLength(1);
    expect((await repository.findInFlightRun(ownerId, conversationId))?.status).toBe("running");
    await expect(repository.findOwnedRun(otherOwnerId, run.id)).resolves.toBeNull();
    await expect(repository.startOwnedRun(otherOwnerId, run.id)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(repository.appendRunMessages(otherOwnerId, run.id, [])).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });

  it("并发助手和工具消息得到连续序号，工具参数和结果可恢复且重试不重复", async () => {
    const { run } = await startRun();
    const inputs = Array.from({ length: 12 }, (_, index) => ({
      id: randomUUID(), role: "tool" as const, toolName: "get_wrong_question", toolCallId: `call-${index}`,
      toolInputJson: { answerId: answerIds[0] }, toolResultJson: { prompt: "测试题", index },
    }));
    await Promise.all(inputs.map((message) => repository.appendRunMessages(ownerId, run.id, [message])));
    await repository.appendRunMessages(ownerId, run.id, inputs);
    const history = await repository.listOwnedMessages(ownerId, conversationId);
    expect(history.map((message) => message.sequenceNo)).toEqual(Array.from({ length: 13 }, (_, index) => index + 1));
    expect(new Set(history.map((message) => message.turnNo))).toEqual(new Set([1]));
    expect(history.filter((message) => message.role === "tool")).toHaveLength(12);
    expect(history.find((message) => message.id === inputs[0].id)).toMatchObject({ toolInputJson: inputs[0].toolInputJson, toolResultJson: inputs[0].toolResultJson });
    await expect(repository.appendRunMessages(ownerId, run.id, [{ ...inputs[0], content: "修改结果" }])).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const page = await repository.listOwnedMessages(ownerId, conversationId, { afterSequenceNo: 5, limit: 3 });
    expect(page.map((message) => message.sequenceNo)).toEqual([6, 7, 8]);
    await expect(repository.listOwnedMessages(otherOwnerId, conversationId)).resolves.toEqual([]);
  });

  it("批量消息中的幂等冲突回滚整批，不留下序号空洞", async () => {
    const { run } = await startRun();
    const existing = { id: randomUUID(), role: "assistant" as const, content: "先想一想" };
    await repository.appendRunMessages(ownerId, run.id, [existing]);
    await expect(repository.appendRunMessages(ownerId, run.id, [
      { id: randomUUID(), role: "assistant", content: "应被回滚" }, { ...existing, content: "冲突" },
    ])).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await repository.listOwnedMessages(ownerId, conversationId)).map((message) => message.sequenceNo)).toEqual([1, 2]);
    const [next] = await repository.appendRunMessages(ownerId, run.id, [{ id: randomUUID(), role: "assistant", content: "继续" }]);
    expect(next.sequenceNo).toBe(3);
  });

  it("完成运行原子保存最终回复、调用统计和会话阶段，并允许相同结果重试", async () => {
    const { run, request } = await startRun();
    await repository.updateRunningRun(ownerId, run.id, { inputTokens: 100, modelCallCount: 1 });
    await repository.updateRunningRun(ownerId, run.id, { inputTokens: 100, modelCallCount: 1 });
    await expect(repository.updateRunningRun(ownerId, run.id, { inputTokens: 50 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const completion: FinishRunInput = {
      ownerId, runId: run.id, status: "succeeded", inputTokens: 120, outputTokens: 30, modelCallCount: 2, toolCallCount: 1,
      subAgentSummaryJson: [{ agent: "socratic-tutor" }], skillSummaryJson: [{ skill: "socratic-tutor" }], tavilySummaryJson: [],
      messages: [{ id: randomUUID(), role: "assistant", content: "函数在哪里定义？" }],
      conversation: { stage: "waiting_for_user", stateJson: { hintLevel: 1 } },
    };
    const first = await repository.finishOwnedRun(completion);
    expect(first).toMatchObject({ status: "succeeded", inputTokens: 120, outputTokens: 30, modelCallCount: 2 });
    expect(first.finishedAt).toBeInstanceOf(Date);
    await expect(repository.finishOwnedRun(completion)).resolves.toEqual(first);
    await expect(repository.finishOwnedRun({ ...completion, outputTokens: 40 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await repository.findOwnedConversation(ownerId, conversationId)).toMatchObject({ stage: "waiting_for_user", stateJson: { hintLevel: 1 } });
    expect(await repository.listOwnedMessages(ownerId, conversationId)).toHaveLength(2);
    await expect(repository.appendRunMessages(ownerId, run.id, [{ id: randomUUID(), role: "assistant", content: "晚到消息" }])).rejects.toMatchObject({ code: "RUN_NOT_RUNNING" });
    await expect(repository.createQueuedRun(request)).resolves.toMatchObject({ created: false });
    await expect(repository.findInFlightRun(ownerId, conversationId)).resolves.toBeNull();
  });

  it("保存失败或取消终态后允许下一轮，归档后拒绝新请求", async () => {
    const queued = await repository.createQueuedRun(createRequest());
    await expect(repository.finishOwnedRun({ ownerId, runId: queued.run.id, status: "succeeded" })).rejects.toMatchObject({ code: "RUN_NOT_RUNNING" });
    await repository.finishOwnedRun({ ownerId, runId: queued.run.id, status: "cancelled" });
    const next = await startRun();
    expect(next.message.turnNo).toBe(2);
    const failed = await repository.finishOwnedRun({ ownerId, runId: next.run.id, status: "failed", errorCode: "TOOL_UNAVAILABLE", errorSummary: "工具未响应" });
    expect(failed).toMatchObject({ status: "failed", errorCode: "TOOL_UNAVAILABLE" });
    await repository.updateOwnedConversation(ownerId, conversationId, { status: "archived" });
    await expect(repository.createQueuedRun(createRequest())).rejects.toMatchObject({ code: "CONVERSATION_NOT_ACTIVE" });
  });

  it("最近 20 轮包含完整工具调用链和当前用户消息，全部历史仍然落库", async () => {
    for (let turn = 1; turn <= 22; turn++) {
      const { run } = await startRun();
      await repository.finishOwnedRun({ ownerId, runId: run.id, status: "succeeded", messages: [
        { id: randomUUID(), role: "assistant", metadataJson: { toolCalls: [{ id: `call-${turn}`, name: "load_skill" }] } },
        { id: randomUUID(), role: "tool", toolName: "load_skill", toolCallId: `call-${turn}`, toolResultJson: { skill: "socratic-tutor" } },
        { id: randomUUID(), role: "assistant", content: `第 ${turn} 轮追问` },
      ] });
    }
    await repository.createQueuedRun(createRequest({ content: "第 23 轮待回复" }));
    const context = await repository.getRecentContext(ownerId, conversationId);
    expect(new Set(context.map((message) => message.turnNo))).toEqual(new Set(Array.from({ length: 20 }, (_, index) => index + 4)));
    expect(context).toHaveLength(19 * 4 + 1);
    expect(context[0]).toMatchObject({ role: "user", turnNo: 4 });
    expect(context.at(-1)).toMatchObject({ role: "user", turnNo: 23 });
    expect(await repository.listOwnedMessages(ownerId, conversationId)).toHaveLength(22 * 4 + 1);
    await expect(repository.getRecentContext(otherOwnerId, conversationId)).resolves.toEqual([]);
  }, 20_000);

  it("长期经历需要真实用户证据，验证运行关联和跨用户隔离并幂等写入", async () => {
    const { run, message } = await startRun();
    const input: RecordLearningMemoryInput = {
      id: randomUUID(), ownerId, conversationId, sourceRunId: run.id, sourceAssessmentAnswerId: answerIds[0],
      memoryType: "error_pattern", knowledgePoint: "词法作用域", pattern: "混淆定义和调用环境",
      evidenceJson: [{ kind: "user_message", sourceId: message.id, observation: "用户回答引用调用环境" }],
      interventionJson: { hintLevel: 1 }, repairStatus: "improving", confidence: 0.86, observedAt: new Date(),
    };
    const first = await repository.recordLearningMemory(input);
    expect(first).toMatchObject({ created: true, memory: { confidence: 0.86, sourceRunId: run.id } });
    await expect(repository.recordLearningMemory(input)).resolves.toMatchObject({ created: false, memory: first.memory });
    await expect(repository.recordLearningMemory({ ...input, pattern: "改写旧经历" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(repository.recordLearningMemory({ ...input, observedAt: new Date(input.observedAt.getTime() + 1_000) })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(repository.recordLearningMemory({ ...input, id: randomUUID(), evidenceJson: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(repository.recordLearningMemory({ ...input, id: randomUUID(), sourceAssessmentAnswerId: answerIds[1] })).rejects.toMatchObject({ code: "INVALID_MEMORY_EVIDENCE" });
    const otherConversation = await repository.createConversation({ ownerId });
    await expect(repository.recordLearningMemory({ ...input, id: randomUUID(), conversationId: otherConversation.id })).rejects.toMatchObject({ code: "INVALID_MEMORY_EVIDENCE" });
    const [assistantMessage] = await repository.appendRunMessages(ownerId, run.id, [{ id: randomUUID(), role: "assistant", content: "模型自己的猜测" }]);
    await expect(repository.recordLearningMemory({ ...input, id: randomUUID(), evidenceJson: [{ kind: "user_message", sourceId: assistantMessage.id, observation: "错误来源" }] })).rejects.toMatchObject({ code: "INVALID_MEMORY_EVIDENCE" });
    await expect(repository.recordLearningMemory({ ...input, id: randomUUID(), evidenceJson: [{ kind: "assessment_answer", sourceId: answerIds[1], observation: "其他用户作答" }] })).rejects.toMatchObject({ code: "INVALID_MEMORY_EVIDENCE" });
    expect(await repository.findOwnedMemories(ownerId, { knowledgePoint: "词法作用域" })).toEqual(expect.arrayContaining([first.memory]));
    await expect(repository.findOwnedMemories(otherOwnerId)).resolves.toEqual([]);
  });

  it("完成运行时消息冲突回滚状态和统计，拒绝非法工具消息和 JSON", async () => {
    const { run } = await startRun();
    const existing = { id: randomUUID(), role: "assistant" as const, content: "原始回复" };
    await repository.appendRunMessages(ownerId, run.id, [existing]);
    await expect(repository.finishOwnedRun({
      ownerId, runId: run.id, status: "succeeded", inputTokens: 500,
      messages: [{ id: randomUUID(), role: "assistant", content: "事务内的新消息" }, { ...existing, content: "冲突回复" }],
      conversation: { stage: "mastered" },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await repository.findOwnedRun(ownerId, run.id)).toMatchObject({ status: "running", inputTokens: 0, finishedAt: null });
    expect(await repository.findOwnedConversation(ownerId, conversationId)).toMatchObject({ stage: "new" });
    expect(await repository.listOwnedMessages(ownerId, conversationId)).toHaveLength(2);
    await expect(repository.appendRunMessages(ownerId, run.id, [{ id: randomUUID(), role: "tool" }])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(repository.updateRunningRun(ownerId, run.id, { inputTokens: -1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(repository.updateRunningRun(ownerId, run.id, { outputSummaryJson: { missing: undefined } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
