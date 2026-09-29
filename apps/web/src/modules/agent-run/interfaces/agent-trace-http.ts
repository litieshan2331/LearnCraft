/**
 * Agent 观测 HTTP 参数与 JSON 展示适配器。
 *
 * 调用顺序：Route 使用 `parseTraceRunListQuery` / `parseTraceEventQuery` 校验参数，
 * 使用 `presentTraceRun` / `presentTraceEvent` 返回稳定的 snake_case 契约；
 * 列表游标由 `encodeTraceRunCursor` 生成、`decodeTraceRunCursor` 还原。
 */

import { z } from "zod";

import type { TraceRunCursor } from "../infrastructure/agent-trace-query";

const uuid = z.uuid();
const positiveLimit = z.coerce.number().int().min(1).max(100);
const sequence = z.coerce.number().int().min(0).max(2_147_483_647);
const runType = z.enum([
  "assessment_generate", "plan_generate", "card_content_generate", "posttest_generate", "adaptation",
]);
const runStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "expired"]);

/** 编码运行列表的稳定复合游标。 */
export function encodeTraceRunCursor(cursor: TraceRunCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id]), "utf8").toString("base64url");
}

/** 还原并严格校验复合游标，非法值返回 null。 */
export function decodeTraceRunCursor(encoded: string): TraceRunCursor | null {
  try {
    if (!/^[A-Za-z0-9_-]{1,500}$/.test(encoded)) return null;
    const values: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!Array.isArray(values) || values.length !== 2 || typeof values[0] !== "string") return null;
    if (!uuid.safeParse(values[1]).success) return null;
    const createdAt = new Date(values[0]);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== values[0]) return null;
    return { createdAt, id: values[1] as string };
  } catch {
    return null;
  }
}

/** 校验运行列表过滤器和分页参数。 */
export function parseTraceRunListQuery(searchParams: URLSearchParams) {
  const parsed = z.object({
    runType: runType.optional(),
    status: runStatus.optional(),
    goalId: uuid.optional(),
    planId: uuid.optional(),
    createdFrom: z.iso.datetime({ offset: true }).optional(),
    createdTo: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().optional(),
    limit: positiveLimit.default(20),
  }).safeParse({
    runType: searchParams.get("run_type") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    goalId: searchParams.get("goal_id") ?? undefined,
    planId: searchParams.get("plan_id") ?? undefined,
    createdFrom: searchParams.get("created_from") ?? undefined,
    createdTo: searchParams.get("created_to") ?? undefined,
    cursor: searchParams.get("cursor") ?? undefined,
    limit: searchParams.get("limit") ?? 20,
  });
  if (!parsed.success) return { success: false as const, error: parsed.error };
  const cursor = parsed.data.cursor ? decodeTraceRunCursor(parsed.data.cursor) : undefined;
  if (parsed.data.cursor && !cursor) return { success: false as const, error: "cursor" };
  return {
    success: true as const,
    data: {
      runType: parsed.data.runType,
      status: parsed.data.status,
      goalId: parsed.data.goalId,
      planId: parsed.data.planId,
      createdFrom: parsed.data.createdFrom ? new Date(parsed.data.createdFrom) : undefined,
      createdTo: parsed.data.createdTo ? new Date(parsed.data.createdTo) : undefined,
      cursor: cursor ?? undefined,
      limit: parsed.data.limit,
    },
  };
}

/** 校验事件游标及页大小；SSE 可使用 Last-Event-ID 自动续传。 */
export function parseTraceEventQuery(searchParams: URLSearchParams, lastEventId?: string | null) {
  return z.object({
    after: sequence.default(0),
    limit: positiveLimit.default(50),
  }).safeParse({
    after: searchParams.get("after") ?? lastEventId ?? 0,
    limit: searchParams.get("limit") ?? 50,
  });
}

/** 将运行元数据映射为观测列表和详情共用的摘要。 */
export function presentTraceRun(run: {
  id: string; goalId: string; goalTitle: string; runType: string; status: string;
  targetType: string; targetId: string; traceId: string; requestedModelId: string | null;
  actualModelProfile: string | null; fallbackReason: string | null; inputTokens: number;
  outputTokens: number; estimatedCostUsd: string; retryCount: number; errorCode: string | null;
  startedAt: Date | null; finishedAt: Date | null; createdAt: Date; updatedAt: Date;
  planTitle?: string | null;
}) {
  return {
    id: run.id,
    goal_id: run.goalId,
    goal_title: run.goalTitle,
    run_type: run.runType,
    status: run.status,
    target_type: run.targetType,
    target_id: run.targetId,
    trace_id: run.traceId,
    requested_model_id: run.requestedModelId,
    actual_model_profile: run.actualModelProfile,
    fallback_reason: run.fallbackReason,
    input_tokens: run.inputTokens,
    output_tokens: run.outputTokens,
    estimated_cost_usd: run.estimatedCostUsd,
    retry_count: run.retryCount,
    error_code: run.errorCode,
    started_at: run.startedAt?.toISOString() ?? null,
    finished_at: run.finishedAt?.toISOString() ?? null,
    created_at: run.createdAt.toISOString(),
    updated_at: run.updatedAt.toISOString(),
    ...(run.planTitle !== undefined ? { plan_title: run.planTitle } : {}),
  };
}

/** 将数据库事件映射为完整轨迹 JSON；payload 不删减。 */
export function presentTraceEvent(event: {
  sequenceNo: number; eventType: string; turnNo: number | null; stepNo: number | null;
  attemptNo: number | null; startedAt: Date | null; finishedAt: Date | null;
  inputTokens: number | null; outputTokens: number | null; payloadJson: unknown; createdAt: Date;
}) {
  return {
    sequence_no: event.sequenceNo,
    event_type: event.eventType,
    turn_no: event.turnNo,
    step_no: event.stepNo,
    attempt_no: event.attemptNo,
    started_at: event.startedAt?.toISOString() ?? null,
    finished_at: event.finishedAt?.toISOString() ?? null,
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    payload: event.payloadJson,
    created_at: event.createdAt.toISOString(),
  };
}
