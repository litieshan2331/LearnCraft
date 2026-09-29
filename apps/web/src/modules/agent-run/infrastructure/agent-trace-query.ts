/**
 * Agent 观测的 PostgreSQL 查询适配器。
 *
 * 调用顺序：列表调用 `listTraceRuns`；详情调用 `findTraceRun`；历史分页和 SSE 轮询
 * 调用 `listTraceEvents`；所有查询都以当前 Session 的 ownerId 隔离。
 */

import { and, asc, desc, eq, gt, lt, or, sql, type SQL } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { agentRuns, agentTraceEvents, learningGoals, learningPlans, planNodes } from "@/lib/db/schema";

export interface TraceRunCursor {
  createdAt: Date;
  id: string;
}

export interface TraceRunFilter {
  ownerId: string;
  runType?: string;
  status?: string;
  goalId?: string;
  planId?: string;
  createdFrom?: Date;
  createdTo?: Date;
  cursor?: TraceRunCursor;
  limit: number;
}

const runColumns = {
  id: agentRuns.id,
  goalId: agentRuns.goalId,
  runType: agentRuns.runType,
  status: agentRuns.status,
  targetType: agentRuns.targetType,
  targetId: agentRuns.targetId,
  traceId: agentRuns.traceId,
  requestedModelId: agentRuns.requestedModelId,
  actualModelProfile: agentRuns.actualModelProfile,
  fallbackReason: agentRuns.fallbackReason,
  inputTokens: agentRuns.inputTokens,
  outputTokens: agentRuns.outputTokens,
  estimatedCostUsd: agentRuns.estimatedCostUsd,
  retryCount: agentRuns.retryCount,
  errorCode: agentRuns.errorCode,
  startedAt: agentRuns.startedAt,
  finishedAt: agentRuns.finishedAt,
  createdAt: agentRuns.createdAt,
  updatedAt: agentRuns.updatedAt,
  goalTitle: learningGoals.title,
};

/** 列出符合过滤条件的运行；额外取一行判定是否还有下一页。 */
export async function listTraceRuns(filter: TraceRunFilter) {
  const conditions: SQL[] = [eq(agentRuns.ownerId, filter.ownerId)];
  if (filter.runType) conditions.push(eq(agentRuns.runType, filter.runType));
  if (filter.status) conditions.push(eq(agentRuns.status, filter.status));
  if (filter.goalId) conditions.push(eq(agentRuns.goalId, filter.goalId));
  if (filter.createdFrom) conditions.push(gt(agentRuns.createdAt, filter.createdFrom));
  if (filter.createdTo) conditions.push(lt(agentRuns.createdAt, filter.createdTo));
  if (filter.cursor) {
    conditions.push(or(
      lt(agentRuns.createdAt, filter.cursor.createdAt),
      and(eq(agentRuns.createdAt, filter.cursor.createdAt), lt(agentRuns.id, filter.cursor.id)),
    )!);
  }
  if (filter.planId) {
    // 节点任务由 plan_nodes 关联；路线生成任务通过输出摘要中的路线 ID 关联。
    conditions.push(or(
      sql`(${agentRuns.targetType} = 'plan_node' AND EXISTS (
        SELECT 1 FROM ${planNodes} WHERE ${planNodes.id} = ${agentRuns.targetId}
        AND ${planNodes.planId} = ${filter.planId} AND ${planNodes.ownerId} = ${filter.ownerId}
      ))`,
      sql`(${agentRuns.runType} = 'plan_generate' AND ${agentRuns.outputSummaryJson}->>'learning_plan_id' = ${filter.planId})`,
    )!);
  }

  const rows = await getDatabase().select(runColumns).from(agentRuns)
    .innerJoin(learningGoals, and(eq(learningGoals.id, agentRuns.goalId), eq(learningGoals.ownerId, filter.ownerId)))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(filter.limit + 1);
  return { items: rows.slice(0, filter.limit), hasMore: rows.length > filter.limit };
}

/** 查找当前用户的运行摘要，包含路线标题（若存在）。 */
export async function findTraceRun(ownerId: string, runId: string) {
  const [row] = await getDatabase().select({ ...runColumns, planTitle: learningPlans.title })
    .from(agentRuns)
    .innerJoin(learningGoals, and(eq(learningGoals.id, agentRuns.goalId), eq(learningGoals.ownerId, ownerId)))
    .leftJoin(learningPlans, and(
      sql`${learningPlans.id}::text = ${agentRuns.outputSummaryJson}->>'learning_plan_id'`,
      eq(learningPlans.ownerId, ownerId),
    ))
    .where(and(eq(agentRuns.ownerId, ownerId), eq(agentRuns.id, runId))).limit(1);
  return row ?? null;
}

/** 从运行内序号 after 之后正向分页，避免读取前页的大型 JSONB。 */
export async function listTraceEvents(ownerId: string, runId: string, after: number, limit: number) {
  const rows = await getDatabase().select().from(agentTraceEvents)
    .innerJoin(agentRuns, eq(agentRuns.id, agentTraceEvents.agentRunId))
    .where(and(
      eq(agentRuns.ownerId, ownerId),
      eq(agentTraceEvents.agentRunId, runId),
      gt(agentTraceEvents.sequenceNo, after),
    ))
    .orderBy(asc(agentTraceEvents.sequenceNo)).limit(limit + 1);
  return { items: rows.slice(0, limit).map((row) => row.agent_trace_events), hasMore: rows.length > limit };
}

/** 查询运行状态，供 SSE 判断已结束时是否关闭连接。 */
export async function findTraceRunStatus(ownerId: string, runId: string): Promise<string | null> {
  const [row] = await getDatabase().select({ status: agentRuns.status })
    .from(agentRuns).where(and(eq(agentRuns.ownerId, ownerId), eq(agentRuns.id, runId))).limit(1);
  return row?.status ?? null;
}
