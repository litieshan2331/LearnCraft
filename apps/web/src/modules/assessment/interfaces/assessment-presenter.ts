/**
 * Assessment 题集的公开 HTTP 响应映射器。
 *
 * 导出：
 * - presentAssessment：返回题干与选项，永不输出答案、解析或评分内部字段。
 */

import type { AssessmentSnapshot } from "../domain/assessment-query";

export function presentAssessment(assessment: AssessmentSnapshot) {
  return {
    id: assessment.id,
    goal_id: assessment.goalId,
    plan_id: assessment.planId,
    kind: assessment.kind,
    status: assessment.status,
    question_count: assessment.requestedQuestionCount ?? assessment.items.length,
    difficulty: assessment.difficulty,
    items: assessment.items.map((item) => ({
      id: item.id,
      ordinal: item.ordinal,
      prompt: item.prompt,
      options: item.options,
      skill_tags: item.skillTags,
      max_score: item.maxScore,
    })),
    created_at: assessment.createdAt.toISOString(),
    updated_at: assessment.updatedAt.toISOString(),
  };
}
