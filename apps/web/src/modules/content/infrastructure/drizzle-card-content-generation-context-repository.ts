/**
 * 节点知识内容生成上下文的 Drizzle 查询适配器。
 *
 * 导出：
 * - DrizzleCardContentGenerationContextRepository：读取当前有效路线中节点、目标和画像快照。
 */

import { and, eq } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { isCurrentLevel } from "@/modules/profile/domain/profile";
import {
  learnerProfiles,
  learningGoals,
  learningPlans,
  planNodes,
  userModelConnections,
} from "@/lib/db/schema";

import type {
  CardContentGenerationContext,
  CardContentGenerationContextRepository,
} from "../domain/content-generation";

export class DrizzleCardContentGenerationContextRepository implements CardContentGenerationContextRepository {
  async findOwnedNodeContext(
    ownerId: string,
    planNodeId: string,
  ): Promise<CardContentGenerationContext | null> {
    const database = getDatabase();
    const [record] = await database
      .select({
        goalId: learningGoals.id,
        planId: learningPlans.id,
        planNodeId: planNodes.id,
        topic: learningGoals.topic,
        goalTitle: learningGoals.title,
        desiredOutcome: learningGoals.desiredOutcome,
        profileVersion: learnerProfiles.profileVersion,
        currentLevel: learnerProfiles.currentLevel,
        weeklyMinutes: learnerProfiles.weeklyMinutes,
        backgroundSummary: learnerProfiles.backgroundSummary,
        nodeKey: planNodes.nodeKey,
        nodeTitle: planNodes.title,
        nodeBrief: planNodes.nodeBrief,
        learningObjective: planNodes.learningObjective,
        rationale: planNodes.rationale,
        difficulty: planNodes.difficulty,
        estimatedMinutes: planNodes.estimatedMinutes,
        completionCriteria: planNodes.completionCriteria,
        contentStatus: planNodes.contentStatus,
      })
      .from(planNodes)
      .innerJoin(learningPlans, and(
        eq(learningPlans.id, planNodes.planId),
        eq(learningPlans.ownerId, ownerId),
        eq(learningPlans.status, "active"),
      ))
      .innerJoin(learningGoals, and(
        eq(learningGoals.id, learningPlans.goalId),
        eq(learningGoals.ownerId, ownerId),
      ))
      .innerJoin(learnerProfiles, eq(learnerProfiles.userId, ownerId))
      .where(and(
        eq(planNodes.id, planNodeId),
        eq(planNodes.ownerId, ownerId),
      ))
      .limit(1);

    if (!record || !isCurrentLevel(record.currentLevel) || !isContentStatus(record.contentStatus)) {
      return null;
    }

    return {
      goalId: record.goalId,
      planId: record.planId,
      planNodeId: record.planNodeId,
      topic: record.topic,
      goalTitle: record.goalTitle,
      desiredOutcome: record.desiredOutcome,
      profileVersion: record.profileVersion,
      currentLevel: record.currentLevel,
      weeklyMinutes: record.weeklyMinutes,
      backgroundSummary: record.backgroundSummary,
      nodeKey: record.nodeKey,
      nodeTitle: record.nodeTitle,
      nodeBrief: record.nodeBrief,
      learningObjective: record.learningObjective,
      rationale: record.rationale,
      difficulty: record.difficulty,
      estimatedMinutes: record.estimatedMinutes,
      completionCriteria: toCriteria(record.completionCriteria),
      contentStatus: record.contentStatus,
    };
  }

  async markContentStatus(
    ownerId: string,
    planNodeId: string,
    status: "generating" | "failed",
  ): Promise<void> {
    const database = getDatabase();
    await database
      .update(planNodes)
      .set({ contentStatus: status, updatedAt: new Date() })
      .where(and(
        eq(planNodes.id, planNodeId),
        eq(planNodes.ownerId, ownerId),
      ));
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

function isContentStatus(
  value: string,
): value is CardContentGenerationContext["contentStatus"] {
  return ["not_requested", "generating", "ready", "failed"].includes(value);
}

function toCriteria(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).filter((item): item is string => typeof item === "string");
  }
  return [];
}