/**
 * Profile HTTP 响应映射器。
 *
 * 导出：
 * - presentLearnerProfile：将画像快照映射为 snake_case API 响应。
 * - presentLearningGoal、presentLearningGoalListItem：将目标快照映射为不含内部字段的单项或列表 API 响应。
 */

import type {
  LearnerProfileSnapshot,
  LearningGoalListItemSnapshot,
  LearningGoalSnapshot,
} from "../domain/profile";

export function presentLearnerProfile(profile: LearnerProfileSnapshot) {
  return {
    current_level: profile.currentLevel,
    primary_language: profile.primaryLanguage,
    weekly_minutes: profile.weeklyMinutes,
    operating_system: profile.operatingSystem,
    background_summary: profile.backgroundSummary,
    content_preference: profile.contentPreference,
    profile_version: profile.profileVersion,
    created_at: profile.createdAt.toISOString(),
    updated_at: profile.updatedAt.toISOString(),
  };
}

export function presentLearningGoal(goal: LearningGoalSnapshot) {
  return {
    id: goal.id,
    topic: goal.topic,
    title: goal.title,
    description: goal.description,
    desired_outcome: goal.desiredOutcome,
    target_date: goal.targetDate,
    weekly_minutes_override: goal.weeklyMinutesOverride,
    model_connection_id: goal.modelConnectionId,
    profile_version: goal.profileVersion,
    status: goal.status,
    active_learning_plan_id: goal.activeLearningPlanId,
    created_at: goal.createdAt.toISOString(),
    updated_at: goal.updatedAt.toISOString(),
  };
}

export function presentLearningGoalListItem(goal: LearningGoalListItemSnapshot) {
  return {
    ...presentLearningGoal(goal),
    latest_assessment: goal.latestDiagnosticAssessment
      ? {
        id: goal.latestDiagnosticAssessment.id,
        status: goal.latestDiagnosticAssessment.status,
        question_count: goal.latestDiagnosticAssessment.questionCount,
        difficulty: goal.latestDiagnosticAssessment.difficulty,
        score_percent: goal.latestDiagnosticAssessment.scorePercent,
        created_at: goal.latestDiagnosticAssessment.createdAt.toISOString(),
        updated_at: goal.latestDiagnosticAssessment.updatedAt.toISOString(),
      }
      : null,
  };
}
