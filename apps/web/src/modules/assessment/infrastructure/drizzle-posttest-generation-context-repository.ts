/**
 * 节点后测上下文的 Drizzle 查询适配器。
 *
 * 导出：
 * - DrizzlePosttestGenerationContextRepository：读取节点、唯一成功内容和目标归属。
 */

import { and, desc, eq, inArray } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import {
  agentRuns,
  assessmentAttempts,
  assessments,
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

  async getGenerationAvailability(ownerId: string, planNodeId: string): Promise<"available" | "active" | "awaiting_attempt"> {
    const database = getDatabase();
    const [activeRun] = await database
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(
        eq(agentRuns.ownerId, ownerId),
        eq(agentRuns.runType, "posttest_generate"),
        eq(agentRuns.targetType, "plan_node"),
        eq(agentRuns.targetId, planNodeId),
        inArray(agentRuns.status, ["queued", "running"]),
      ))
      .limit(1);
    if (activeRun) {
      return "active";
    }

    const [latestAssessment] = await database
      .select({ id: assessments.id })
      .from(assessments)
      .where(and(
        eq(assessments.ownerId, ownerId),
        eq(assessments.planNodeId, planNodeId),
        eq(assessments.kind, "post_test"),
      ))
      .orderBy(desc(assessments.createdAt), desc(assessments.id))
      .limit(1);
    if (!latestAssessment) {
      return "available";
    }

    const [attempt] = await database
      .select({ id: assessmentAttempts.id })
      .from(assessmentAttempts)
      .where(and(
        eq(assessmentAttempts.ownerId, ownerId),
        eq(assessmentAttempts.assessmentId, latestAssessment.id),
        eq(assessmentAttempts.status, "graded"),
      ))
      .limit(1);
    return attempt ? "available" : "awaiting_attempt";
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