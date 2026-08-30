/**
 * Assessment 题集的公开 HTTP 响应映射器。
 *
 * 导出：
 * - presentAssessment：返回题干与选项，永不输出答案、解析或评分内部字段。
 */

import type { AssessmentSnapshot, PosttestAssessmentSummary } from "../domain/assessment-query";

export function presentAssessment(assessment: AssessmentSnapshot) {
  return {
    id: assessment.id,
    goal_id: assessment.goalId,
    plan_id: assessment.planId,
    plan_node_id: assessment.planNodeId,
    source_card_content_id: assessment.sourceCardContentId,
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

export function presentPosttestAssessments(items: PosttestAssessmentSummary[]) {
  return {
    items: items.map((item) => ({
      assessment_id: item.assessmentId,
      plan_node_id: item.planNodeId,
      source_card_content_id: item.sourceCardContentId,
      kind: "post_test" as const,
      status: item.status,
      question_count: item.questionCount,
      difficulty: item.difficulty,
      created_at: item.createdAt.toISOString(),
      updated_at: item.updatedAt.toISOString(),
      latest_attempt: item.latestAttempt ? {
        id: item.latestAttempt.id,
        assessment_id: item.latestAttempt.assessmentId,
        attempt_no: item.latestAttempt.attemptNo,
        status: item.latestAttempt.status,
        score_percent: item.latestAttempt.scorePercent,
        wrong_count: item.latestAttempt.wrongCount,
        submitted_at: item.latestAttempt.submittedAt.toISOString(),
        graded_at: item.latestAttempt.gradedAt.toISOString(),
      } : null,
    })),
  };
}