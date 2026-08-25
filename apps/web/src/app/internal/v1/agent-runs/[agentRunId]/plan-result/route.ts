/**
 * Agent Worker 提交 plan_generate 结果的内部 Route Handler。
 *
 * 主要职责：校验学习路线合同与依赖 DAG，在单个事务中持久化路线、章节节点和前置关系。
 */

import { timingSafeEqual } from "node:crypto";

import { and, eq, max, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabase } from "@/lib/db/client";
import {
  agentRuns,
  learningGoals,
  learningPlans,
  planNodePrerequisites,
  planNodes,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agentRunId: string }>;
}

const nodeSchema = z.object({
  node_key: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
  ordinal: z.number().int().min(1).max(12),
  title: z.string().min(1).max(255),
  node_brief: z.string().min(1).max(2_000),
  learning_objective: z.string().min(1).max(2_000),
  rationale: z.string().min(1).max(2_000),
  difficulty: z.number().int().min(1).max(5),
  estimated_minutes: z.number().int().min(5).max(1_440),
  prerequisite_node_keys: z.array(
    z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
  ).max(11).default([]),
  completion_criteria: z.array(z.string().min(1).max(1_000)).min(1).max(10),
}).strict();

const resultSchema = z.object({
  schema_version: z.literal("learning_plan.v1"),
  title: z.string().min(1).max(255),
  summary: z.string().min(1).max(2_000),
  nodes: z.array(nodeSchema).min(6).max(12),
  generation_metadata: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((value, context) => {
  const nodeKeys = new Set<string>();
  const ordinals = new Set<number>();

  for (const [index, node] of value.nodes.entries()) {
    if (nodeKeys.has(node.node_key)) {
      context.addIssue({ code: "custom", path: ["nodes", index, "node_key"], message: "node_key 必须唯一。" });
    }
    nodeKeys.add(node.node_key);

    if (ordinals.has(node.ordinal)) {
      context.addIssue({ code: "custom", path: ["nodes", index, "ordinal"], message: "ordinal 必须唯一。" });
    }
    ordinals.add(node.ordinal);
  }

  for (let ordinal = 1; ordinal <= value.nodes.length; ordinal += 1) {
    if (!ordinals.has(ordinal)) {
      context.addIssue({ code: "custom", path: ["nodes"], message: "章节 ordinal 必须从 1 连续编号。" });
      break;
    }
  }

  const prerequisitesByKey = new Map<string, string[]>();
  for (const [index, node] of value.nodes.entries()) {
    const prerequisiteSet = new Set<string>();
    for (const prerequisiteKey of node.prerequisite_node_keys) {
      if (prerequisiteSet.has(prerequisiteKey)) {
        context.addIssue({ code: "custom", path: ["nodes", index, "prerequisite_node_keys"], message: "前置节点不能重复。" });
      }
      prerequisiteSet.add(prerequisiteKey);
      if (!nodeKeys.has(prerequisiteKey)) {
        context.addIssue({ code: "custom", path: ["nodes", index, "prerequisite_node_keys"], message: "前置节点必须存在于当前路线。" });
      }
      if (prerequisiteKey === node.node_key) {
        context.addIssue({ code: "custom", path: ["nodes", index, "prerequisite_node_keys"], message: "节点不能依赖自身。" });
      }
    }
    prerequisitesByKey.set(node.node_key, node.prerequisite_node_keys);
  }

  if (hasCycle(prerequisitesByKey)) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "路线前置依赖必须无环。" });
  }
});

const inputSnapshotSchema = z.object({
  learner_profile: z.object({
    profile_version: z.number().int().min(1),
  }).passthrough(),
}).passthrough();

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!hasValidInternalSecret(request)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const { agentRunId } = await context.params;
  const runId = z.uuid().safeParse(agentRunId);
  if (!runId.success) {
    return NextResponse.json({ error: "INVALID_AGENT_RUN_ID" }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const parsed = resultSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "VALIDATION_ERROR", field_errors: parsed.error.issues }, { status: 422 });
  }

  const database = getDatabase();
  const persisted = await database.transaction(async (transaction) => {
    const [run] = await transaction
      .select({
        ownerId: agentRuns.ownerId,
        goalId: agentRuns.goalId,
        targetId: agentRuns.targetId,
        targetType: agentRuns.targetType,
        runType: agentRuns.runType,
        inputSummaryJson: agentRuns.inputSummaryJson,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId.data))
      .limit(1);

    if (
      !run
      || run.runType !== "plan_generate"
      || run.targetType !== "learning_goal"
      || run.targetId !== run.goalId
    ) {
      return { kind: "not_found" as const };
    }

    const inputSnapshot = inputSnapshotSchema.safeParse(run.inputSummaryJson);
    if (!inputSnapshot.success) {
      return { kind: "input_invalid" as const };
    }

    const [goal] = await transaction
      .select({ id: learningGoals.id })
      .from(learningGoals)
      .where(and(
        eq(learningGoals.id, run.goalId),
        eq(learningGoals.ownerId, run.ownerId),
      ))
      .limit(1)
      .for("update");

    if (!goal) {
      return { kind: "not_found" as const };
    }

    const [existing] = await transaction
      .select({
        id: learningPlans.id,
        nodeCount: sql`count(${planNodes.id})`,
      })
      .from(learningPlans)
      .leftJoin(planNodes, eq(planNodes.planId, learningPlans.id))
      .where(and(
        eq(learningPlans.ownerId, run.ownerId),
        eq(learningPlans.goalId, run.goalId),
        sql`${learningPlans.generationMetadata} ->> 'agent_run_id' = ${runId.data}`,
      ))
      .groupBy(learningPlans.id)
      .limit(1);

    if (existing) {
      return { kind: "ok" as const, id: existing.id, nodeCount: Number(existing.nodeCount) };
    }

    const [latestVersion] = await transaction
      .select({ version: max(learningPlans.version) })
      .from(learningPlans)
      .where(eq(learningPlans.goalId, run.goalId));
    const nextVersion = (latestVersion?.version ?? 0) + 1;
    const now = new Date();

    await transaction
      .update(learningPlans)
      .set({ status: "superseded", updatedAt: now })
      .where(and(
        eq(learningPlans.goalId, run.goalId),
        eq(learningPlans.status, "active"),
      ));

    const [plan] = await transaction
      .insert(learningPlans)
      .values({
        ownerId: run.ownerId,
        goalId: run.goalId,
        profileVersion: inputSnapshot.data.learner_profile.profile_version,
        inputSnapshotJson: run.inputSummaryJson,
        version: nextVersion,
        title: parsed.data.title,
        summary: parsed.data.summary,
        status: "active",
        schemaVersion: parsed.data.schema_version,
        generationMetadata: {
          ...parsed.data.generation_metadata,
          agent_run_id: runId.data,
        },
        generatedAt: now,
      })
      .returning({ id: learningPlans.id });

    if (!plan) {
      throw new Error("learning_plan 插入后未返回记录。");
    }

    const insertedNodes = await transaction
      .insert(planNodes)
      .values(parsed.data.nodes.map((node) => ({
        ownerId: run.ownerId,
        planId: plan.id,
        parentNodeId: null,
        nodeKey: node.node_key,
        nodeBrief: node.node_brief,
        ordinal: node.ordinal,
        nodeKind: "core" as const,
        title: node.title,
        learningObjective: node.learning_objective,
        rationale: node.rationale,
        difficulty: node.difficulty,
        estimatedMinutes: node.estimated_minutes,
        completionCriteria: node.completion_criteria,
        status: "available" as const,
        contentStatus: "not_requested" as const,
        insertedReason: null,
      })))
      .returning({ id: planNodes.id, nodeKey: planNodes.nodeKey });

    const nodeIdByKey = new Map(insertedNodes.map((node) => [node.nodeKey, node.id]));
    const prerequisites = parsed.data.nodes.flatMap((node) => {
      const nodeId = nodeIdByKey.get(node.node_key);
      if (!nodeId) {
        throw new Error("新建节点缺少持久化标识。");
      }
      return node.prerequisite_node_keys.map((prerequisiteKey) => {
        const prerequisiteNodeId = nodeIdByKey.get(prerequisiteKey);
        if (!prerequisiteNodeId) {
          throw new Error("新建路线存在无法解析的前置节点。");
        }
        return { nodeId, prerequisiteNodeId };
      });
    });

    if (prerequisites.length > 0) {
      await transaction.insert(planNodePrerequisites).values(prerequisites);
    }

    return { kind: "ok" as const, id: plan.id, nodeCount: insertedNodes.length };
  });

  if (persisted.kind === "not_found") {
    return NextResponse.json({ error: "AGENT_RUN_NOT_FOUND" }, { status: 404 });
  }
  if (persisted.kind === "input_invalid") {
    return NextResponse.json({ error: "PLAN_INPUT_SNAPSHOT_INVALID" }, { status: 422 });
  }

  return NextResponse.json({
    learning_plan_id: persisted.id,
    node_count: persisted.nodeCount,
  });
}

function hasCycle(prerequisitesByKey: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeKey: string): boolean => {
    if (visiting.has(nodeKey)) {
      return true;
    }
    if (visited.has(nodeKey)) {
      return false;
    }

    visiting.add(nodeKey);
    for (const prerequisiteKey of prerequisitesByKey.get(nodeKey) ?? []) {
      if (visit(prerequisiteKey)) {
        return true;
      }
    }
    visiting.delete(nodeKey);
    visited.add(nodeKey);
    return false;
  };

  return [...prerequisitesByKey.keys()].some(visit);
}

function hasValidInternalSecret(request: Request): boolean {
  const expected = process.env.INTERNAL_SERVICE_SECRET?.trim();
  const supplied = request.headers.get("x-learncraft-internal-secret")?.trim();
  if (!expected || !supplied) {
    return false;
  }

  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}