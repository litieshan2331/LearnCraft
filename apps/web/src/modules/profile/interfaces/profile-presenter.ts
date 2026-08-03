/**
 * Profile HTTP 响应映射器。
 *
 * 导出：
 * - presentLearnerProfile：将画像快照映射为 snake_case API 响应。
 * - presentLearningGoal：将学习目标快照映射为不含内部字段的 API 响应。
 */

import type { LearnerProfileSnapshot, LearningGoalSnapshot } from "../domain/profile";

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
    created_at: goal.createdAt.toISOString(),
    updated_at: goal.updatedAt.toISOString(),
  };
}
