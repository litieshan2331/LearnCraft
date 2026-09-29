/**
 * 当前用户 Agent 完整轨迹的游标分页接口。
 *
 * 调用顺序：GET 校验 Session/归属/参数，再按运行内 sequence_no 正向分页读取 JSONB。
 */

import { NextResponse } from "next/server";

import { findTraceRunStatus, listTraceEvents } from "@/modules/agent-run/infrastructure/agent-trace-query";
import { agentRunPathSchema, applyAgentRunSessionRenewal, authenticateAgentRunRequest } from "@/modules/agent-run/interfaces/agent-run-http";
import { parseTraceEventQuery, presentTraceEvent } from "@/modules/agent-run/interfaces/agent-trace-http";
import { apiErrorResponse, validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { params: Promise<{ runId: string }> }

/** 返回当前用户指定运行中游标之后的完整事件。 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const auth = await authenticateAgentRunRequest(request);
    if (!auth.authenticated) return auth.response;
    const { runId } = await context.params;
    const path = agentRunPathSchema.safeParse({ agent_run_id: runId });
    if (!path.success) return applyAgentRunSessionRenewal(validationErrorResponse(path.error), auth);
    const query = parseTraceEventQuery(new URL(request.url).searchParams);
    if (!query.success) return applyAgentRunSessionRenewal(validationErrorResponse(query.error), auth);

    const status = await findTraceRunStatus(auth.ownerId, runId);
    if (!status) return applyAgentRunSessionRenewal(apiErrorResponse(404, "AGENT_RUN_NOT_FOUND", "任务不存在或你无权访问。"), auth);
    const page = await listTraceEvents(auth.ownerId, runId, query.data.after, query.data.limit);
    const last = page.items.at(-1);
    return applyAgentRunSessionRenewal(NextResponse.json({
      items: page.items.map(presentTraceEvent),
      next_cursor: page.hasMore && last ? last.sequenceNo : null,
    }), auth);
  } catch {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }
}
