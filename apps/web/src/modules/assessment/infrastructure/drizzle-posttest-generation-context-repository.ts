/**
 * 节点后测上下文的 Drizzle 查询适配器。
 *
 * 导出：
 * - DrizzlePosttestGenerationContextRepository：读取节点、唯一成功内容和目标归属。
 */

import { and, eq } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import {
  cardContents,
  learningGoals,
  learningPlans,
  planNodes,
  userModelConnections,
} from "@/lib/db/schema";

import type {
  PosttestGenerationContext,
  PosttestGenerationContextRepository,
} from "../domain/posttest-generation";

export class DrizzlePosttestGenerationContextRepository implements PosttestGenerationContextRepository {
  async findOwnedNodeContext(
    ownerId: string,
    planNodeId: string,
  ): Promise<PosttestGenerationContext | null> {
    const database = getDatabase();
    const [record] = await database
      .select({
        goalId: learningGoals.id,
        planNodeId: planNodes.id,
        cardContentId: cardContents.id,
        topic: learningGoals.topic,
      })
      .from(planNodes)
      .innerJoin(
        learningPlans,
        and(
          eq(learningPlans.id, planNodes.planId),
          eq(learningPlans.ownerId, ownerId),
        ),
      )
      .innerJoin(learningGoals, and(
        eq(learningGoals.id, learningPlans.goalId),
        eq(learningGoals.ownerId, ownerId),
      ))
      .leftJoin(cardContents, and(
        eq(cardContents.planNodeId, planNodes.id),
        eq(cardContents.ownerId, ownerId),
        eq(cardContents.status, "ready"),
      ))
      .where(and(
        eq(planNodes.id, planNodeId),
        eq(planNodes.ownerId, ownerId),
      ))
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