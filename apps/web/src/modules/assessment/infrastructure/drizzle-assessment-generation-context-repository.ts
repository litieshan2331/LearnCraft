/**
 * Assessment 生成上下文的 Drizzle 查询适配器。
 *
 * 导出：
 * - DrizzleAssessmentGenerationContextRepository：读取目标、画像、路线和账户默认模型的归属状态。
 */

import { and, eq } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import {
  learnerProfiles,
  learningGoals,
  userModelConnections,
} from "@/lib/db/schema";

import type {
  AssessmentGenerationContext,
  AssessmentGenerationContextRepository,
} from "../domain/assessment-generation";

export class DrizzleAssessmentGenerationContextRepository implements AssessmentGenerationContextRepository {
  async findOwnedGoalContext(ownerId: string, goalId: string): Promise<AssessmentGenerationContext | null> {
    const database = getDatabase();
    const [record] = await database
      .select({
        topic: learningGoals.topic,
        title: learningGoals.title,
        description: learningGoals.description,
        desiredOutcome: learningGoals.desiredOutcome,
        backgroundSummary: learnerProfiles.backgroundSummary,
        overallExperience: learnerProfiles.currentLevel,
      })
      .from(learningGoals)
      .leftJoin(learnerProfiles, eq(learnerProfiles.userId, learningGoals.ownerId))
      .where(and(eq(learningGoals.id, goalId), eq(learningGoals.ownerId, ownerId)))
      .limit(1);

    return record ?? null;
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
