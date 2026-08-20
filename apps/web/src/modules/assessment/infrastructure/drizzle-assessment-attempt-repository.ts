/**
 * Assessment 作答与确定性评分的 Drizzle 持久化适配器。
 *
 * 类与函数：
 * - DrizzleAssessmentAttemptRepository：在单个事务内校验答案、保存作答并完成单选题评分。
 * - toAssessmentAttemptSnapshot、toAssessmentAttemptSummary：映射安全的作答读取快照。
 * - scoreSubmittedAnswers：根据服务端答案键计算每题及总分。
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import {
  assessmentAnswers,
  assessmentAttempts,
  assessmentItems,
  assessments,
  idempotencyKeys,
} from "@/lib/db/schema";

import {
  AssessmentAttemptApplicationError,
  type AssessmentAttemptRepository,
  type AssessmentAttemptSnapshot,
  type AssessmentAttemptSubmissionDecision,
  type AssessmentAttemptSubmissionInput,
  type AssessmentAttemptSummarySnapshot,
  type SelectedAssessmentAnswer,
} from "../domain/assessment-attempt";
import type { AssessmentOptionSnapshot } from "../domain/assessment-query";

const IDEMPOTENCY_SCOPE = "assessment_attempt.submit";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const GRADING_VERSION = "deterministic.single_choice.v1";

type AssessmentItemRecord = typeof assessmentItems.$inferSelect;
type AssessmentAttemptRecord = typeof assessmentAttempts.$inferSelect;
type AssessmentAnswerRecord = typeof assessmentAnswers.$inferSelect;

interface ScoredAnswer {
  item: AssessmentItemRecord;
  selectedOptionKey: string;
  correctOptionKey: string;
  isCorrect: boolean;
  score: number;
  weaknessTags: string[];
}

export class DrizzleAssessmentAttemptRepository implements AssessmentAttemptRepository {
  async submitOwnedAttempt(
    input: AssessmentAttemptSubmissionInput,
  ): Promise<AssessmentAttemptSubmissionDecision> {
    const database = getDatabase();

    return database.transaction(async (transaction) => {
      const [idempotencyRecord] = await transaction
        .insert(idempotencyKeys)
        .values({
          actorKey: input.ownerId,
          scope: IDEMPOTENCY_SCOPE,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          status: "processing",
          responseJson: {},
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        })
        .onConflictDoNothing()
        .returning({ id: idempotencyKeys.id });

      if (!idempotencyRecord) {
        const [existingIdempotency] = await transaction
          .select()
          .from(idempotencyKeys)
          .where(and(
            eq(idempotencyKeys.actorKey, input.ownerId),
            eq(idempotencyKeys.scope, IDEMPOTENCY_SCOPE),
            eq(idempotencyKeys.idempotencyKey, input.idempotencyKey),
          ))
          .limit(1);

        if (!existingIdempotency || existingIdempotency.requestHash !== input.requestHash) {
          throw new AssessmentAttemptApplicationError("IDEMPOTENCY_CONFLICT");
        }
        if (
          existingIdempotency.status !== "succeeded"
          || existingIdempotency.resourceType !== "assessment_attempt"
          || !existingIdempotency.resourceId
        ) {
          throw new Error("作答幂等请求尚未完成，无法返回确定结果。");
        }
        return { kind: "existing", attemptId: existingIdempotency.resourceId };
      }

      const [assessment] = await transaction
        .select()
        .from(assessments)
        .where(and(eq(assessments.id, input.assessmentId), eq(assessments.ownerId, input.ownerId)))
        .limit(1)
        .for("update");

      if (!assessment) {
        await transaction.delete(idempotencyKeys).where(eq(idempotencyKeys.id, idempotencyRecord.id));
        return { kind: "assessment_not_found" };
      }
      const [existingAttempt] = await transaction
        .select({ id: assessmentAttempts.id })
        .from(assessmentAttempts)
        .where(and(
          eq(assessmentAttempts.assessmentId, assessment.id),
          eq(assessmentAttempts.ownerId, input.ownerId),
        ))
        .limit(1);
      if (existingAttempt) {
        await transaction.delete(idempotencyKeys).where(eq(idempotencyKeys.id, idempotencyRecord.id));
        return { kind: "already_submitted" };
      }
      if (assessment.status !== "ready") {
        await transaction.delete(idempotencyKeys).where(eq(idempotencyKeys.id, idempotencyRecord.id));
        return { kind: "assessment_not_submittable" };
      }

      const items = await transaction
        .select()
        .from(assessmentItems)
        .where(eq(assessmentItems.assessmentId, assessment.id))
        .orderBy(asc(assessmentItems.ordinal));
      const scoredAnswers = scoreSubmittedAnswers(items, input.answers);
      if (!scoredAnswers) {
        await transaction.delete(idempotencyKeys).where(eq(idempotencyKeys.id, idempotencyRecord.id));
        return { kind: "invalid_answers" };
      }

      const now = new Date();
      const totalScore = roundScore(scoredAnswers.reduce((sum, answer) => sum + answer.score, 0));
      const maxScore = roundScore(scoredAnswers.reduce((sum, answer) => sum + Number(answer.item.maxScore), 0));
      const scorePercent = maxScore === 0 ? 0 : roundScore((totalScore / maxScore) * 100);
      const masterySummary = buildMasterySummary(scoredAnswers);

      const [attempt] = await transaction
        .insert(assessmentAttempts)
        .values({
          ownerId: input.ownerId,
          assessmentId: assessment.id,
          attemptNo: 1,
          status: "graded",
          totalScore: toStorageScore(totalScore),
          maxScore: toStorageScore(maxScore),
          scorePercent: toStorageScore(scorePercent),
          masterySummary,
          gradingVersion: GRADING_VERSION,
          submittedAt: now,
          gradedAt: now,
        })
        .returning({ id: assessmentAttempts.id });
      if (!attempt) {
        throw new Error("保存作答后未返回作答记录。");
      }

      await transaction.insert(assessmentAnswers).values(scoredAnswers.map((answer) => ({
        attemptId: attempt.id,
        assessmentItemId: answer.item.id,
        answerJson: { selected_option_key: answer.selectedOptionKey },
        isCorrect: answer.isCorrect,
        score: toStorageScore(answer.score),
        feedback: null,
        weaknessTags: answer.weaknessTags,
        gradingMetadataJson: { grading_version: GRADING_VERSION },
        gradedAt: now,
      })));

      await transaction
        .update(assessments)
        .set({
          status: "graded",
          totalScore: toStorageScore(totalScore),
          maxScore: toStorageScore(maxScore),
          scorePercent: toStorageScore(scorePercent),
          masterySummary,
          updatedAt: now,
        })
        .where(eq(assessments.id, assessment.id));

      await transaction
        .update(idempotencyKeys)
        .set({
          status: "succeeded",
          responseStatus: 201,
          resourceType: "assessment_attempt",
          resourceId: attempt.id,
          responseJson: { assessment_attempt_id: attempt.id },
          updatedAt: now,
        })
        .where(eq(idempotencyKeys.id, idempotencyRecord.id));

      return { kind: "created", attemptId: attempt.id };
    });
  }

  async findOwnedAttempt(ownerId: string, attemptId: string): Promise<AssessmentAttemptSnapshot | null> {
    const database = getDatabase();
    const [attempt] = await database
      .select()
      .from(assessmentAttempts)
      .where(and(
        eq(assessmentAttempts.id, attemptId),
        eq(assessmentAttempts.ownerId, ownerId),
        eq(assessmentAttempts.status, "graded"),
      ))
      .limit(1);
    if (!attempt) {
      return null;
    }

    const [items, answers] = await Promise.all([
      database
        .select()
        .from(assessmentItems)
        .where(eq(assessmentItems.assessmentId, attempt.assessmentId))
        .orderBy(asc(assessmentItems.ordinal)),
      database
        .select()
        .from(assessmentAnswers)
        .where(eq(assessmentAnswers.attemptId, attempt.id)),
    ]);

    return toAssessmentAttemptSnapshot(attempt, items, answers);
  }

  async findOwnedAttempts(
    ownerId: string,
    assessmentId: string,
  ): Promise<AssessmentAttemptSummarySnapshot[] | null> {
    const database = getDatabase();
    const [assessment] = await database
      .select({ id: assessments.id })
      .from(assessments)
      .where(and(eq(assessments.id, assessmentId), eq(assessments.ownerId, ownerId)))
      .limit(1);
    if (!assessment) {
      return null;
    }

    const attempts = await database
      .select()
      .from(assessmentAttempts)
      .where(and(
        eq(assessmentAttempts.assessmentId, assessment.id),
        eq(assessmentAttempts.ownerId, ownerId),
        eq(assessmentAttempts.status, "graded"),
      ))
      .orderBy(desc(assessmentAttempts.attemptNo), desc(assessmentAttempts.createdAt));
    if (attempts.length === 0) {
      return [];
    }

    const answers = await database
      .select({ attemptId: assessmentAnswers.attemptId, isCorrect: assessmentAnswers.isCorrect })
      .from(assessmentAnswers)
      .where(inArray(assessmentAnswers.attemptId, attempts.map((attempt) => attempt.id)));
    const wrongCounts = new Map<string, number>();
    for (const answer of answers) {
      if (answer.isCorrect === false) {
        wrongCounts.set(answer.attemptId, (wrongCounts.get(answer.attemptId) ?? 0) + 1);
      }
    }

    return attempts.map((attempt) => toAssessmentAttemptSummary(
      attempt,
      wrongCounts.get(attempt.id) ?? 0,
    ));
  }
}

function scoreSubmittedAnswers(
  items: AssessmentItemRecord[],
  submittedAnswers: SelectedAssessmentAnswer[],
): ScoredAnswer[] | null {
  if (items.length === 0 || submittedAnswers.length !== items.length) {
    return null;
  }

  const answersByItemId = new Map<string, string>();
  for (const answer of submittedAnswers) {
    if (answersByItemId.has(answer.assessmentItemId)) {
      return null;
    }
    answersByItemId.set(answer.assessmentItemId, answer.selectedOptionKey);
  }

  const scoredAnswers: ScoredAnswer[] = [];
  for (const item of items) {
    const selectedOptionKey = answersByItemId.get(item.id);
    const options = toAssessmentOptions(item.optionsJson);
    const correctOptionKey = toCorrectOptionKey(item.answerKeyJson);
    if (!selectedOptionKey || !options.some((option) => option.key === selectedOptionKey)) {
      return null;
    }

    const isCorrect = selectedOptionKey === correctOptionKey;
    scoredAnswers.push({
      item,
      selectedOptionKey,
      correctOptionKey,
      isCorrect,
      score: isCorrect ? Number(item.maxScore) : 0,
      weaknessTags: isCorrect ? [] : item.skillTags,
    });
  }
  return scoredAnswers;
}

function toAssessmentAttemptSnapshot(
  attempt: AssessmentAttemptRecord,
  items: AssessmentItemRecord[],
  answers: AssessmentAnswerRecord[],
): AssessmentAttemptSnapshot {
  if (
    attempt.status !== "graded"
    || attempt.totalScore === null
    || attempt.maxScore === null
    || attempt.scorePercent === null
    || !attempt.gradingVersion
    || !attempt.submittedAt
    || !attempt.gradedAt
  ) {
    throw new Error("作答记录不是可展示的已评分状态。");
  }

  const answersByItemId = new Map(answers.map((answer) => [answer.assessmentItemId, answer]));
  return {
    id: attempt.id,
    assessmentId: attempt.assessmentId,
    attemptNo: attempt.attemptNo,
    status: "graded",
    totalScore: Number(attempt.totalScore),
    maxScore: Number(attempt.maxScore),
    scorePercent: Number(attempt.scorePercent),
    masterySummary: toRecord(attempt.masterySummary),
    gradingVersion: attempt.gradingVersion,
    submittedAt: attempt.submittedAt,
    gradedAt: attempt.gradedAt,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    items: items.map((item) => {
      const answer = answersByItemId.get(item.id);
      if (!answer || answer.isCorrect === null || answer.score === null || !answer.gradedAt) {
        throw new Error("已评分作答缺少题目答案或评分结果。");
      }
      return {
        assessmentItemId: item.id,
        ordinal: item.ordinal,
        prompt: item.prompt,
        options: toAssessmentOptions(item.optionsJson),
        skillTags: item.skillTags,
        maxScore: Number(item.maxScore),
        selectedOptionKey: toSelectedOptionKey(answer.answerJson),
        correctOptionKey: toCorrectOptionKey(item.answerKeyJson),
        isCorrect: answer.isCorrect,
        score: Number(answer.score),
        explanation: item.explanation,
        weaknessTags: answer.weaknessTags,
      };
    }),
  };
}

function toAssessmentAttemptSummary(
  attempt: AssessmentAttemptRecord,
  wrongCount: number,
): AssessmentAttemptSummarySnapshot {
  if (
    attempt.status !== "graded"
    || attempt.scorePercent === null
    || !attempt.submittedAt
    || !attempt.gradedAt
  ) {
    throw new Error("作答历史包含非已评分记录。");
  }
  return {
    id: attempt.id,
    assessmentId: attempt.assessmentId,
    attemptNo: attempt.attemptNo,
    status: "graded",
    scorePercent: Number(attempt.scorePercent),
    wrongCount,
    submittedAt: attempt.submittedAt,
    gradedAt: attempt.gradedAt,
  };
}

function toAssessmentOptions(value: unknown): AssessmentOptionSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("题目选项不是数组。");
  }
  return value.map((option) => {
    if (
      typeof option !== "object"
      || option === null
      || typeof option.key !== "string"
      || typeof option.text !== "string"
    ) {
      throw new Error("题目选项格式不正确。");
    }
    return { key: option.key, text: option.text };
  });
}

function toCorrectOptionKey(value: unknown): string {
  if (
    typeof value !== "object"
    || value === null
    || typeof (value as { correct_option?: unknown }).correct_option !== "string"
  ) {
    throw new Error("题目答案键格式不正确。");
  }
  return (value as { correct_option: string }).correct_option;
}

function toSelectedOptionKey(value: unknown): string {
  if (
    typeof value !== "object"
    || value === null
    || typeof (value as { selected_option_key?: unknown }).selected_option_key !== "string"
  ) {
    throw new Error("作答答案格式不正确。");
  }
  return (value as { selected_option_key: string }).selected_option_key;
}

function buildMasterySummary(scoredAnswers: ScoredAnswer[]): Record<string, unknown> {
  const skillTagResults = new Map<string, { correct: number; total: number }>();
  for (const answer of scoredAnswers) {
    for (const skillTag of answer.item.skillTags) {
      const result = skillTagResults.get(skillTag) ?? { correct: 0, total: 0 };
      result.total += 1;
      if (answer.isCorrect) {
        result.correct += 1;
      }
      skillTagResults.set(skillTag, result);
    }
  }

  return {
    correct_count: scoredAnswers.filter((answer) => answer.isCorrect).length,
    incorrect_count: scoredAnswers.filter((answer) => !answer.isCorrect).length,
    skill_tag_results: Object.fromEntries(skillTagResults),
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toStorageScore(value: number): string {
  return roundScore(value).toFixed(2);
}
