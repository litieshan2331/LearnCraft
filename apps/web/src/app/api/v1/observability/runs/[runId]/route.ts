/**
 * 当前用户 Agent 观测运行摘要接口。
 *
 * 调用顺序：GET 校验 Session 和 runId，再以 owner_id 查找运行；不存在或不归属均返回 404。
 */

import { NextResponse } from "next/server";

import { findTraceRun } from "@/modules/agent-run/infrastructure/agent-trace-query";
import { agentRunPathSchema, applyAgentRunSessionRenewal, authenticateAgentRunRequest } from "@/modules/agent-run/interfaces/agent-run-http";
import { presentTraceRun } from "@/modules/agent-run/interfaces/agent-trace-http";
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

    const run = await findTraceRun(auth.ownerId, runId);
    if (!run) return applyAgentRunSessionRenewal(apiErrorResponse(404, "AGENT_RUN_NOT_FOUND", "任务不存在或你无权访问。"), auth);
    return applyAgentRunSessionRenewal(NextResponse.json(presentTraceRun(run)), auth);
  } catch {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }
}
