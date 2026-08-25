/**
 * Assessment 题集读取的 Drizzle 持久化适配器。
 *
 * 导出：
 * - DrizzleAssessmentQueryRepository：查询当前用户拥有的题集与不含答案的题目字段。
 */

import { and, asc, eq } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { assessmentItems, assessments } from "@/lib/db/schema";

import {
  isAssessmentKind,
  isAssessmentStatus,
  type AssessmentItemSnapshot,
  type AssessmentOptionSnapshot,
  type AssessmentQueryRepository,
  type AssessmentSnapshot,
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
