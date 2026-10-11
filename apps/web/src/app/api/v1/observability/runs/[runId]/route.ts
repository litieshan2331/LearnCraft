/**
 * 当前用户 Agent 观测运行摘要接口。
 *
 * 调用顺序：GET 校验 Session 和 runId；普通请求返回摘要，`events=1` 返回事件页，`stream=1` 返回 SSE；
 * 最后均按 owner_id 隔离，不存在或不归属统一返回 404。
 */

import { NextResponse } from "next/server";

import { findTraceRun, findTraceRunStatus, listTraceEvents } from "@/modules/agent-run/infrastructure/agent-trace-query";
import { agentRunPathSchema, applyAgentRunSessionRenewal, authenticateAgentRunRequest } from "@/modules/agent-run/interfaces/agent-run-http";
import { parseTraceEventQuery, presentTraceEvent, presentTraceRun } from "@/modules/agent-run/interfaces/agent-trace-http";
import { createAgentTraceSseResponse } from "@/modules/agent-run/interfaces/agent-trace-sse";
import { apiErrorResponse, validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ runId: string }> }

/** 查询当前用户的一次运行摘要。 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const auth = await authenticateAgentRunRequest(request);
    if (!auth.authenticated) return auth.response;
    const { runId } = await context.params;
    const parsed = agentRunPathSchema.safeParse({ agent_run_id: runId });
    if (!parsed.success) return applyAgentRunSessionRenewal(validationErrorResponse(parsed.error), auth);

    const searchParams = new URL(request.url).searchParams;
    const isEventsRequest = searchParams.get("events") === "1";
    const isStreamRequest = searchParams.get("stream") === "1";
    if (isEventsRequest || isStreamRequest) {
      const query = parseTraceEventQuery(searchParams, request.headers.get("last-event-id"));
      if (!query.success) return applyAgentRunSessionRenewal(validationErrorResponse(query.error), auth);
      const status = await findTraceRunStatus(auth.ownerId, runId);
      if (!status) return applyAgentRunSessionRenewal(apiErrorResponse(404, "AGENT_RUN_NOT_FOUND", "任务不存在或你无权访问。"), auth);
      if (isStreamRequest) {
        return applyAgentRunSessionRenewal(createAgentTraceSseResponse({
          after: query.data.after,
          signal: request.signal,
          readPage: (after) => listTraceEvents(auth.ownerId, runId, after, 100),
          readStatus: () => findTraceRunStatus(auth.ownerId, runId),
        }), auth);
      }
      const page = await listTraceEvents(auth.ownerId, runId, query.data.after, query.data.limit);
      const last = page.items.at(-1);
      return applyAgentRunSessionRenewal(NextResponse.json({
        items: page.items.map(presentTraceEvent),
        next_cursor: page.hasMore && last ? last.sequenceNo : null,
      }), auth);
    }

    const run = await findTraceRun(auth.ownerId, runId);
    if (!run) return applyAgentRunSessionRenewal(apiErrorResponse(404, "AGENT_RUN_NOT_FOUND", "任务不存在或你无权访问。"), auth);
    return applyAgentRunSessionRenewal(NextResponse.json(presentTraceRun(run)), auth);
  } catch {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }
}
