/**
 * AgentRun 实时进度订阅 Route Handler（SSE）。
 *
 * 函数：
 * - GET：校验会话与任务归属后，以 text/event-stream 持续推送该运行的进度事件（仅生成过程中有事件）。
 *
 * 说明：进度是临时通道——不落库、不重放；订阅不可用时仍返回正常 SSE 流（只发 keep-alive），
 * 前端因此回退到状态轮询与现有等待界面。任务归属校验复用 AgentRun 应用服务，
 * 未授权或不存在的任务仍返回与状态查询一致的 404。
 */

import { NextResponse } from "next/server";

import { getAgentRunService } from "@/modules/agent-run/infrastructure/agent-run-service-factory";
import { subscribeAgentProgress } from "@/modules/agent-run/infrastructure/agent-progress-subscriber";
import {
  agentRunErrorResponse,
  agentRunPathSchema,
  applyAgentRunSessionRenewal,
  authenticateAgentRunRequest,
} from "@/modules/agent-run/interfaces/agent-run-http";
import { createAgentProgressSseResponse } from "@/modules/agent-run/interfaces/agent-progress-sse";
import { validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agentRunId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const authentication = await authenticateAgentRunRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const params = await context.params;
    const parsedParams = agentRunPathSchema.safeParse({ agent_run_id: params.agentRunId });
    if (!parsedParams.success) {
      return applyAgentRunSessionRenewal(
        validationErrorResponse(parsedParams.error),
        authentication,
      );
    }

    // 归属校验：只有任务所有者能订阅自己的运行进度；不存在或无权访问时抛 404。
    await getAgentRunService().getOwnedRun(
      authentication.ownerId,
      parsedParams.data.agent_run_id,
    );

    const response = createAgentProgressSseResponse({
      runId: parsedParams.data.agent_run_id,
      subscribe: (input) => subscribeAgentProgress(input),
      signal: request.signal,
    });
    return applyAgentRunSessionRenewal(response, authentication);
  } catch (error) {
    return agentRunErrorResponse(error);
  }
}
