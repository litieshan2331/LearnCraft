/**
 * 当前用户 Agent 完整轨迹的可重放 SSE 接口。
 *
 * 调用顺序：GET 校验 Session/归属/游标，然后按 owner_id 轮询 PostgreSQL 事件；
 * SSE id 为 sequence_no，重连时可用 after 或 Last-Event-ID 续传。
 */

import { NextResponse } from "next/server";

import { findTraceRunStatus, listTraceEvents } from "@/modules/agent-run/infrastructure/agent-trace-query";
import { agentRunPathSchema, applyAgentRunSessionRenewal, authenticateAgentRunRequest } from "@/modules/agent-run/interfaces/agent-run-http";
import { parseTraceEventQuery } from "@/modules/agent-run/interfaces/agent-trace-http";
import { createAgentTraceSseResponse } from "@/modules/agent-run/interfaces/agent-trace-sse";
import { apiErrorResponse, validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ runId: string }> }

/** 返回只包含当前用户事件的 SSE 流，并支持断线游标续传。 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const auth = await authenticateAgentRunRequest(request);
    if (!auth.authenticated) return auth.response;
    const { runId } = await context.params;
    const path = agentRunPathSchema.safeParse({ agent_run_id: runId });
    if (!path.success) return applyAgentRunSessionRenewal(validationErrorResponse(path.error), auth);
    const query = parseTraceEventQuery(new URL(request.url).searchParams, request.headers.get("last-event-id"));
    if (!query.success) return applyAgentRunSessionRenewal(validationErrorResponse(query.error), auth);
    const status = await findTraceRunStatus(auth.ownerId, runId);
    if (!status) return applyAgentRunSessionRenewal(apiErrorResponse(404, "AGENT_RUN_NOT_FOUND", "任务不存在或你无权访问。"), auth);

    return applyAgentRunSessionRenewal(createAgentTraceSseResponse({
      after: query.data.after,
      signal: request.signal,
      readPage: (after) => listTraceEvents(auth.ownerId, runId, after, 100),
      readStatus: () => findTraceRunStatus(auth.ownerId, runId),
    }), auth);
  } catch {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }
}
