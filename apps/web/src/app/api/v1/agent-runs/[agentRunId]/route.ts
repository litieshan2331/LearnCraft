/**
 * AgentRun 状态读取 Route Handler。
 *
 * 函数：
 * - GET：返回当前登录用户拥有的 AgentRun 安全状态快照。
 */

import { NextResponse } from "next/server";

import { getAgentRunService } from "@/modules/agent-run/infrastructure/agent-run-service-factory";
import {
  agentRunErrorResponse,
  agentRunPathSchema,
  applyAgentRunSessionRenewal,
  authenticateAgentRunRequest,
} from "@/modules/agent-run/interfaces/agent-run-http";
import { presentAgentRun } from "@/modules/agent-run/interfaces/agent-run-presenter";
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

    const agentRun = await getAgentRunService().getOwnedRun(
      authentication.ownerId,
      parsedParams.data.agent_run_id,
    );
    return applyAgentRunSessionRenewal(NextResponse.json(presentAgentRun(agentRun)), authentication);
  } catch (error) {
    return agentRunErrorResponse(error);
  }
}
