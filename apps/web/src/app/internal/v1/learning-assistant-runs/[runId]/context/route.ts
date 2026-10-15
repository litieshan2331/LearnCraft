/**
 * 学习助手 Worker 读取可信运行上下文的内部接口。
 * 调用顺序：校验共享密钥 → 锁定运行和会话归属 → 读取最近 20 轮消息、错题、画像、掌握度与学习经历 → 返回严格上下文合同。
 * Worker 和模型不能通过请求参数指定 owner、conversation 或 question；所有关联均由 run_id 反查得到。
 */
import { timingSafeEqual } from "node:crypto";

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabase } from "@/lib/db/client";
import {
  assessmentAnswers,
  assessmentAttempts,
  assessmentItems,
  assessments,
  learnerProfiles,
  learningAssistantConversations,
  learningAssistantMessages,
  learningAssistantRuns,
  learningExperienceMemories,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ runId: string }> }
const contextTurns = 20;

/** 读取运行绑定的全部可信学习上下文。 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!hasValidInternalSecret(request)) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const params = await context.params;
  const parsedRunId = z.uuid().safeParse(params.runId);
  if (!parsedRunId.success) return NextResponse.json({ error: "INVALID_RUN_ID" }, { status: 400 });

  const database = getDatabase();
  const [run] = await database.select({
    id: learningAssistantRuns.id,
    ownerId: learningAssistantRuns.ownerId,
    conversationId: learningAssistantRuns.conversationId,
    triggerMessageId: learningAssistantRuns.triggerMessageId,
  }).from(learningAssistantRuns).where(eq(learningAssistantRuns.id, parsedRunId.data)).limit(1);
  if (!run) return NextResponse.json({ error: "LEARNING_ASSISTANT_CONTEXT_NOT_FOUND" }, { status: 404 });

  const [conversation] = await database.select({
    sourceAssessmentAnswerId: learningAssistantConversations.sourceAssessmentAnswerId,
    stateJson: learningAssistantConversations.stateJson,
  }).from(learningAssistantConversations).where(and(
    eq(learningAssistantConversations.id, run.conversationId),
    eq(learningAssistantConversations.ownerId, run.ownerId),
  )).limit(1);
  if (!conversation) return NextResponse.json({ error: "LEARNING_ASSISTANT_CONTEXT_NOT_FOUND" }, { status: 404 });

  const recentMessages = await readRecentMessages(database, run.conversationId);
  const wrongQuestion = await readWrongQuestion(database, run.ownerId, conversation.sourceAssessmentAnswerId);
  const profile = await readProfile(database, run.ownerId);
  const mastery = await readMastery(database, run.ownerId, conversation.sourceAssessmentAnswerId);
  const memories = await readLearningContext(database, run.ownerId);
  const questionId = wrongQuestion?.assessment_item_id ?? null;
  const evidence = wrongQuestion === null ? [] : [{
    id: String(wrongQuestion.answer_id), kind: "assessment_answer" as const,
    source_id: String(wrongQuestion.answer_id), content: JSON.stringify(wrongQuestion), turn_no: null, executed: true,
  }];

  const response = {
    run_id: run.id,
    conversation_id: run.conversationId,
    owner_id: run.ownerId,
    question_id: questionId,
    recent_messages: recentMessages,
    wrong_question: wrongQuestion,
    user_profile: profile,
    mastery_state: mastery,
    learning_context: { memories, conversation_state: toRecord(conversation.stateJson) },
    evidence,
  };
  return NextResponse.json(response);
}

/** 读取最近 20 个 turn 的全部消息，保留一个 turn 内完整工具调用链。 */
async function readRecentMessages(database: ReturnType<typeof getDatabase>, conversationId: string) {
  const recentTurns = database.selectDistinct({ turnNo: learningAssistantMessages.turnNo })
    .from(learningAssistantMessages).where(eq(learningAssistantMessages.conversationId, conversationId))
    .orderBy(desc(learningAssistantMessages.turnNo)).limit(contextTurns);
  const rows = await database.select().from(learningAssistantMessages)
    .where(and(eq(learningAssistantMessages.conversationId, conversationId), inArray(learningAssistantMessages.turnNo, recentTurns)))
    .orderBy(asc(learningAssistantMessages.sequenceNo));
  return rows.map((message) => {
    const metadata = toRecord(message.metadataJson);
    const toolCalls = Array.isArray(metadata.tool_calls) ? metadata.tool_calls.flatMap((call) => {
      if (typeof call !== "object" || call === null || Array.isArray(call)) return [];
      const value = call as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id : null;
      const name = typeof value.name === "string" ? value.name : null;
      const argumentsJson = typeof value.arguments_json === "string" ? value.arguments_json
        : typeof value.argumentsJson === "string" ? value.argumentsJson : null;
      return id !== null && name !== null && argumentsJson !== null ? [{ id, name, arguments_json: argumentsJson }] : [];
    }) : [];
    return {
      id: message.id,
      turn_no: message.turnNo,
      role: message.role as "user" | "assistant" | "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.toolName,
      tool_calls: toolCalls,
    };
  });
}

/** 读取会话关联的现有测评错题和用户作答。 */
async function readWrongQuestion(database: ReturnType<typeof getDatabase>, ownerId: string, answerId: string | null) {
  if (answerId === null) return null;
  const [row] = await database.select({
    answer_id: assessmentAnswers.id,
    assessment_item_id: assessmentAnswers.assessmentItemId,
    prompt: assessmentItems.prompt,
    options_json: assessmentItems.optionsJson,
    answer_key_json: assessmentItems.answerKeyJson,
    explanation: assessmentItems.explanation,
    answer_json: assessmentAnswers.answerJson,
    is_correct: assessmentAnswers.isCorrect,
    feedback: assessmentAnswers.feedback,
    weakness_tags: assessmentAnswers.weaknessTags,
  }).from(assessmentAnswers)
    .innerJoin(assessmentItems, eq(assessmentItems.id, assessmentAnswers.assessmentItemId))
    .innerJoin(assessmentAttempts, eq(assessmentAttempts.id, assessmentAnswers.attemptId))
    .where(and(eq(assessmentAnswers.id, answerId), eq(assessmentAttempts.ownerId, ownerId))).limit(1);
  return row ?? null;
}

/** 读取用户画像；没有画像时返回 null，让模型知道事实缺失。 */
async function readProfile(database: ReturnType<typeof getDatabase>, ownerId: string) {
  const [profile] = await database.select({
    current_level: learnerProfiles.currentLevel,
    primary_language: learnerProfiles.primaryLanguage,
    weekly_minutes: learnerProfiles.weeklyMinutes,
    operating_system: learnerProfiles.operatingSystem,
    background_summary: learnerProfiles.backgroundSummary,
    preferences_json: learnerProfiles.preferencesJson,
    profile_version: learnerProfiles.profileVersion,
  }).from(learnerProfiles).where(eq(learnerProfiles.userId, ownerId)).limit(1);
  return profile ?? null;
}

/** 从来源测评的最近一次已评分作答读取掌握度摘要。 */
async function readMastery(database: ReturnType<typeof getDatabase>, ownerId: string, answerId: string | null) {
  if (answerId === null) return null;
  const [source] = await database.select({ assessmentId: assessmentAttempts.assessmentId })
    .from(assessmentAnswers).innerJoin(assessmentAttempts, eq(assessmentAttempts.id, assessmentAnswers.attemptId))
    .where(and(eq(assessmentAnswers.id, answerId), eq(assessmentAttempts.ownerId, ownerId))).limit(1);
  if (!source) return null;
  const [attempt] = await database.select({
    attempt_id: assessmentAttempts.id,
    assessment_id: assessmentAttempts.assessmentId,
    score_percent: assessmentAttempts.scorePercent,
    mastery_summary: assessmentAttempts.masterySummary,
    graded_at: assessmentAttempts.gradedAt,
  }).from(assessmentAttempts).innerJoin(assessments, eq(assessments.id, assessmentAttempts.assessmentId))
    .where(and(
      eq(assessmentAttempts.assessmentId, source.assessmentId),
      eq(assessmentAttempts.ownerId, ownerId),
      eq(assessments.ownerId, ownerId),
      eq(assessmentAttempts.status, "graded"),
    )).orderBy(desc(assessmentAttempts.gradedAt)).limit(1);
  return attempt ?? null;
}

/** 读取服务端维护的学习经历摘要，不暴露给公开用户 API。 */
async function readLearningContext(database: ReturnType<typeof getDatabase>, ownerId: string) {
  const rows = await database.select({
    id: learningExperienceMemories.id,
    memory_type: learningExperienceMemories.memoryType,
    knowledge_point: learningExperienceMemories.knowledgePoint,
    error_type: learningExperienceMemories.errorType,
    pattern: learningExperienceMemories.pattern,
    evidence_json: learningExperienceMemories.evidenceJson,
    intervention_json: learningExperienceMemories.interventionJson,
    repair_status: learningExperienceMemories.repairStatus,
    confidence: learningExperienceMemories.confidence,
    observed_at: learningExperienceMemories.observedAt,
  }).from(learningExperienceMemories).where(eq(learningExperienceMemories.ownerId, ownerId))
    .orderBy(desc(learningExperienceMemories.observedAt)).limit(20);
  return rows;
}

/** 将 JSONB 安全转换为对象，避免把数组或 null 当成可信记录。 */
function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 使用恒定时间比较内部服务密钥。 */
function hasValidInternalSecret(request: Request): boolean {
  const expected = process.env.INTERNAL_SERVICE_SECRET?.trim();
  const supplied = request.headers.get("x-learncraft-internal-secret")?.trim();
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected, "utf8"); const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
