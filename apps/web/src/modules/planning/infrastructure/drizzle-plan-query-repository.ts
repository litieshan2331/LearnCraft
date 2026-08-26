/**
 * 学习计划与节点查询的 Drizzle 适配器。
 *
 * 导出：
 * - DrizzlePlanQueryRepository：按所有者读取路线、章节和前置关系。
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import {
  learningPlans,
  planNodePrerequisites,
  planNodes,
} from "@/lib/db/schema";

import type {
  LearningPlanNodeSnapshot,
  LearningPlanSnapshot,
  PlanNodeSnapshot,
  PlanQueryRepository,
} from "../domain/plan-query";

export class DrizzlePlanQueryRepository implements PlanQueryRepository {
  async findOwnedPlan(ownerId: string, planId: string): Promise<LearningPlanSnapshot | null> {
    const database = getDatabase();
    const [plan] = await database
      .select()
      .from(learningPlans)
      .where(and(
        eq(learningPlans.id, planId),
        eq(learningPlans.ownerId, ownerId),
      ))
      .limit(1);

    if (!plan) {
      return null;
    }

    const nodes = await database
      .select()
      .from(planNodes)
      .where(and(
        eq(planNodes.planId, plan.id),
        eq(planNodes.ownerId, ownerId),
      ))
      .orderBy(asc(planNodes.ordinal));

    const nodeSnapshots = await withPrerequisiteIds(database, nodes);

    return {
      id: plan.id,
      goalId: plan.goalId,
      version: plan.version,
      title: plan.title,
      summary: plan.summary,
      status: plan.status,
      profileVersion: plan.profileVersion,
      schemaVersion: plan.schemaVersion,
      nodes: nodeSnapshots,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }

  async findOwnedNode(ownerId: string, nodeId: string): Promise<PlanNodeSnapshot | null> {
    const database = getDatabase();
    const [record] = await database
      .select({
        node: planNodes,
        planTitle: learningPlans.title,
        planStatus: learningPlans.status,
        goalId: learningPlans.goalId,
      })
      .from(planNodes)
      .innerJoin(learningPlans, and(
        eq(learningPlans.id, planNodes.planId),
        eq(learningPlans.ownerId, ownerId),
      ))
      .where(and(
        eq(planNodes.id, nodeId),
        eq(planNodes.ownerId, ownerId),
      ))
      .limit(1);

    if (!record) {
      return null;
    }

    const [nodeSnapshot] = await withPrerequisiteIds(database, [record.node]);
    if (!nodeSnapshot) {
      return null;
    }

    return {
      ...nodeSnapshot,
      goalId: record.goalId,
      planTitle: record.planTitle,
      planStatus: record.planStatus,
    };
  }
}

async function withPrerequisiteIds(
  database: ReturnType<typeof getDatabase>,
  nodes: typeof planNodes.$inferSelect[],
): Promise<LearningPlanNodeSnapshot[]> {
  if (nodes.length === 0) {
    return [];
  }

  const prerequisites = await database
    .select({
      nodeId: planNodePrerequisites.nodeId,
      prerequisiteNodeId: planNodePrerequisites.prerequisiteNodeId,
    })
    .from(planNodePrerequisites)
    .where(inArray(
      planNodePrerequisites.nodeId,
      nodes.map((node) => node.id),
    ));

  const nodeIds = new Set(nodes.map((node) => node.id));
  const prerequisitesByNode = new Map<string, string[]>();
  for (const prerequisite of prerequisites) {
    if (!nodeIds.has(prerequisite.prerequisiteNodeId)) {
      continue;
    }
    const values = prerequisitesByNode.get(prerequisite.nodeId) ?? [];
    values.push(prerequisite.prerequisiteNodeId);
    prerequisitesByNode.set(prerequisite.nodeId, values);
  }

  return nodes.map((node) => ({
    id: node.id,
    planId: node.planId,
    nodeKey: node.nodeKey,
    ordinal: node.ordinal,
    title: node.title,
    nodeBrief: node.nodeBrief,
    learningObjective: node.learningObjective,
    rationale: node.rationale,
    difficulty: node.difficulty,
    estimatedMinutes: node.estimatedMinutes,
    completionCriteria: toCriteria(node.completionCriteria),
    status: node.status,
    contentStatus: node.contentStatus,
    prerequisiteNodeIds: prerequisitesByNode.get(node.id) ?? [],
  }));
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