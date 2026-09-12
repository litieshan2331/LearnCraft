/**
 * Assessment 题集读取的 Drizzle 持久化适配器。
 *
 * 导出：
 * - DrizzleAssessmentQueryRepository：查询当前用户拥有的题集与不含答案的题目字段。
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { assessmentAnswers, assessmentAttempts, assessmentItems, assessments } from "@/lib/db/schema";

import {
  isAssessmentKind,
  isAssessmentStatus,
  type AssessmentItemSnapshot,
  type AssessmentOptionSnapshot,
  type AssessmentQueryRepository,
  type AssessmentSnapshot,
  type PosttestAssessmentSummary,
} from "../domain/assessment-query";

type AssessmentRecord = typeof assessments.$inferSelect;
type AssessmentItemRecord = typeof assessmentItems.$inferSelect;

export class DrizzleAssessmentQueryRepository implements AssessmentQueryRepository {
  async findOwnedAssessment(ownerId: string, assessmentId: string): Promise<AssessmentSnapshot | null> {
    const database = getDatabase();
    const [assessment] = await database
      .select()
      .from(assessments)
      .where(and(eq(assessments.id, assessmentId), eq(assessments.ownerId, ownerId)))
      .limit(1);

    if (!assessment) {
      return null;
    }

    const items = await database
      .select()
      .from(assessmentItems)
      .where(eq(assessmentItems.assessmentId, assessment.id))
      .orderBy(asc(assessmentItems.ordinal));

    return toAssessmentSnapshot(assessment, items);
  }
  async findOwnedPosttestsByNode(ownerId: string, planNodeId: string): Promise<PosttestAssessmentSummary[]> {
    const database = getDatabase();
    const records = await database
      .select()
      .from(assessments)
      .where(and(
        eq(assessments.ownerId, ownerId),
        eq(assessments.planNodeId, planNodeId),
        eq(assessments.kind, "post_test"),
      ))
      .orderBy(desc(assessments.createdAt), desc(assessments.id));

    if (records.length === 0) {
      return [];
    }

    const attempts = await database
      .select()
      .from(assessmentAttempts)
      .where(and(
        eq(assessmentAttempts.ownerId, ownerId),
        inArray(assessmentAttempts.assessmentId, records.map((record) => record.id)),
        eq(assessmentAttempts.status, "graded"),
      ))
      .orderBy(desc(assessmentAttempts.attemptNo), desc(assessmentAttempts.createdAt));
    const latestAttempts = new Map<string, typeof attempts[number]>();
    for (const attempt of attempts) {
      if (!latestAttempts.has(attempt.assessmentId)) {
        latestAttempts.set(attempt.assessmentId, attempt);
      }
    }

    const wrongCounts = new Map<string, number>();
    if (attempts.length > 0) {
      const answers = await database
        .select({ attemptId: assessmentAnswers.attemptId, isCorrect: assessmentAnswers.isCorrect })
        .from(assessmentAnswers)
        .where(inArray(assessmentAnswers.attemptId, attempts.map((attempt) => attempt.id)));
      for (const answer of answers) {
        if (answer.isCorrect === false) {
          wrongCounts.set(answer.attemptId, (wrongCounts.get(answer.attemptId) ?? 0) + 1);
        }
      }
    }

    return records.map((record, index) => {
      if (!record.planNodeId || !record.sourceCardContentId) {
        throw new Error("数据库中的后测缺少节点或节点内容绑定。");
      }
      const attempt = latestAttempts.get(record.id);
      return {
        posttestNo: records.length - index,
        assessmentId: record.id,
        planNodeId: record.planNodeId,
        sourceCardContentId: record.sourceCardContentId,
        status: isAssessmentStatus(record.status) ? record.status : "failed",
        questionCount: record.requestedQuestionCount ?? 0,
        difficulty: record.difficulty === "hard" ? "hard" : "normal",
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        latestAttempt: attempt
          ? {
              id: attempt.id,
              assessmentId: attempt.assessmentId,
              attemptNo: attempt.attemptNo,
              status: "graded",
              scorePercent: Number(attempt.scorePercent ?? 0),
              wrongCount: wrongCounts.get(attempt.id) ?? 0,
              submittedAt: attempt.submittedAt ?? attempt.createdAt,
              gradedAt: attempt.gradedAt ?? attempt.updatedAt,
            }
          : null,
      } satisfies PosttestAssessmentSummary;
    });
  }
}

function toAssessmentSnapshot(
  assessment: AssessmentRecord,
  items: AssessmentItemRecord[],
): AssessmentSnapshot {
  if (!isAssessmentKind(assessment.kind) || !isAssessmentStatus(assessment.status)) {
    throw new Error("数据库中存在不受支持的 Assessment 类型或状态。");
  }
  if (assessment.difficulty !== "normal" && assessment.difficulty !== "hard") {
    throw new Error("数据库中存在不受支持的 Assessment 难度。");
  }

  return {
    id: assessment.id,
    goalId: assessment.goalId,
    planId: assessment.planId,
    planNodeId: assessment.planNodeId,
    sourceCardContentId: assessment.sourceCardContentId,
    kind: assessment.kind,
    status: assessment.status,
    requestedQuestionCount: assessment.requestedQuestionCount,
    difficulty: assessment.difficulty,
    items: items.map(toAssessmentItemSnapshot),
    createdAt: assessment.createdAt,
    updatedAt: assessment.updatedAt,
  };
}

function toAssessmentItemSnapshot(item: AssessmentItemRecord): AssessmentItemSnapshot {
  return {
    id: item.id,
    ordinal: item.ordinal,
    prompt: item.prompt,
    options: toAssessmentOptions(item.optionsJson),
    skillTags: item.skillTags,
    maxScore: Number(item.maxScore),
  };
}

function toAssessmentOptions(value: unknown): AssessmentOptionSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("数据库中的题目选项不是数组。");
  }

  return value.map((option) => {
    if (
      typeof option !== "object"
      || option === null
      || typeof option.key !== "string"
      || typeof option.text !== "string"
    ) {
      throw new Error("数据库中的题目选项格式不正确。");
    }

    return { key: option.key, text: option.text };
  });

}
