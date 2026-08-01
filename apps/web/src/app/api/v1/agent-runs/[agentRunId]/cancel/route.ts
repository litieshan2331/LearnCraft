/**
 * AgentRun 协作式取消 Route Handler。
 *
 * 函数：
 * - POST：校验同源和任务所有者，将 queued 或 running 任务标记为 cancelled。
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
import {
  assertAllowedWriteOrigin,
  validationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ agentRunId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) {
    return originError;
  }

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

    const agentRun = await getAgentRunService().cancelOwnedRun(
      authentication.ownerId,
      parsedParams.data.agent_run_id,
    );
    return applyAgentRunSessionRenewal(NextResponse.json(presentAgentRun(agentRun)), authentication);
  } catch (error) {
    return agentRunErrorResponse(error);
  }
}
