/**
 * Assessment 作答评分结果的 HTTP 响应映射器。
 *
 * 函数：
 * - presentAssessmentAttempt：提交后或详情页返回完整评分、答案与解析。
 * - presentAssessmentAttemptSummary：返回历史作答列表的安全摘要。
 */

import type {
  AssessmentAttemptSnapshot,
  AssessmentAttemptSummarySnapshot,
} from "../domain/assessment-attempt";

export function presentAssessmentAttempt(attempt: AssessmentAttemptSnapshot) {
  return {
    id: attempt.id,
    assessment_id: attempt.assessmentId,
    attempt_no: attempt.attemptNo,
    status: attempt.status,
    score: {
      total_score: attempt.totalScore,
      max_score: attempt.maxScore,
      score_percent: attempt.scorePercent,
    },
    mastery_summary: attempt.masterySummary,
    grading_version: attempt.gradingVersion,
    submitted_at: attempt.submittedAt.toISOString(),
    graded_at: attempt.gradedAt.toISOString(),
    created_at: attempt.createdAt.toISOString(),
    updated_at: attempt.updatedAt.toISOString(),
    items: attempt.items.map((item) => ({
      assessment_item_id: item.assessmentItemId,
      ordinal: item.ordinal,
      prompt: item.prompt,
      options: item.options,
      skill_tags: item.skillTags,
      max_score: item.maxScore,
      selected_option_key: item.selectedOptionKey,
      correct_option_key: item.correctOptionKey,
      is_correct: item.isCorrect,
      score: item.score,
      explanation: item.explanation,
      weakness_tags: item.weaknessTags,
    })),
  };
}

export function presentAssessmentAttemptSummary(attempt: AssessmentAttemptSummarySnapshot) {
  return {
    id: attempt.id,
    assessment_id: attempt.assessmentId,
    attempt_no: attempt.attemptNo,
    status: attempt.status,
    score_percent: attempt.scorePercent,
    wrong_count: attempt.wrongCount,
    submitted_at: attempt.submittedAt.toISOString(),
    graded_at: attempt.gradedAt.toISOString(),
  };
}
