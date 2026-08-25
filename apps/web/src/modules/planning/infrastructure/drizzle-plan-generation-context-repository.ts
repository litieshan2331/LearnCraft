/**
 * 学习路线生成上下文的 Drizzle 查询适配器。
 *
 * 导出：
 * - DrizzlePlanGenerationContextRepository：读取当前画像和最新已评分前测摘要。
 */

import { and, desc, eq } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { isCurrentLevel } from "@/modules/profile/domain/profile";
import {
  assessments,
  learnerProfiles,
  learningGoals,
  userModelConnections,
} from "@/lib/db/schema";

import type {
  PlanGenerationContext,
  PlanGenerationContextRepository,
} from "../domain/plan-generation";

export class DrizzlePlanGenerationContextRepository implements PlanGenerationContextRepository {
  async findOwnedReadyContext(
    ownerId: string,
    goalId: string,
  ): Promise<PlanGenerationContext | null> {
    const database = getDatabase();
    const [goal] = await database
      .select({
        goalId: learningGoals.id,
        topic: learningGoals.topic,
        title: learningGoals.title,
        description: learningGoals.description,
        desiredOutcome: learningGoals.desiredOutcome,
        profileVersion: learnerProfiles.profileVersion,
        currentLevel: learnerProfiles.currentLevel,
        weeklyMinutes: learnerProfiles.weeklyMinutes,
        backgroundSummary: learnerProfiles.backgroundSummary,
      })
      .from(learningGoals)
      .innerJoin(learnerProfiles, eq(learnerProfiles.userId, learningGoals.ownerId))
      .where(and(
        eq(learningGoals.id, goalId),
        eq(learningGoals.ownerId, ownerId),
      ))
      .limit(1);

    if (!goal) {
      return null;
    }

    const currentLevel = goal.currentLevel;
    if (!isCurrentLevel(currentLevel)) {
      return null;
    }

    const [assessment] = await database
      .select({
        assessmentId: assessments.id,
        scorePercent: assessments.scorePercent,
        masterySummary: assessments.masterySummary,
      })
      .from(assessments)
      .where(and(
        eq(assessments.ownerId, ownerId),
        eq(assessments.goalId, goalId),
        eq(assessments.kind, "diagnostic"),
        eq(assessments.status, "graded"),
      ))
      .orderBy(desc(assessments.updatedAt), desc(assessments.id))
      .limit(1);

    if (!assessment || assessment.scorePercent === null) {
      return null;
    }

    return {
      goalId: goal.goalId,
      topic: goal.topic,
      title: goal.title,
      description: goal.description,
      desiredOutcome: goal.desiredOutcome,
      profileVersion: goal.profileVersion,
      currentLevel,
      weeklyMinutes: goal.weeklyMinutes,
      backgroundSummary: goal.backgroundSummary,
      assessmentId: assessment.assessmentId,
      assessmentScorePercent: Number(assessment.scorePercent),
      assessmentMasterySummary: toRecord(assessment.masterySummary),
    };
  }

  async hasDefaultModelConnection(ownerId: string): Promise<boolean> {
    const database = getDatabase();
    const [record] = await database
      .select({ id: userModelConnections.id })
      .from(userModelConnections)
      .where(and(
        eq(userModelConnections.ownerId, ownerId),
        eq(userModelConnections.status, "active"),
        eq(userModelConnections.isDefault, true),
      ))
      .limit(1);

    return Boolean(record);
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}