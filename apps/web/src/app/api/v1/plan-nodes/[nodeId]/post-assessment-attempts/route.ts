/**
 * 节点后测作答记录 Route Handler。
 *
 * 函数：
 * - GET：返回当前用户指定章节下所有已完成后测的评分摘要。
 */

import { NextResponse } from "next/server";

import { applyAgentRunSessionRenewal, authenticateAgentRunRequest } from "@/modules/agent-run/interfaces/agent-run-http";
import { getAssessmentQueryService } from "@/modules/assessment/infrastructure/assessment-query-service-factory";
import { assessmentQueryErrorResponse, planNodePathSchema } from "@/modules/assessment/interfaces/assessment-query-http";
import { presentPosttestAssessmentAttempts } from "@/modules/assessment/interfaces/assessment-presenter";
import { validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ nodeId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const authentication = await authenticateAgentRunRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const params = await context.params;
    const parsedParams = planNodePathSchema.safeParse({ plan_node_id: params.nodeId });
    if (!parsedParams.success) {
      return applyAgentRunSessionRenewal(
        validationErrorResponse(parsedParams.error),
        authentication,
      );
    }

    const items = await getAssessmentQueryService().listOwnedPosttestAttemptsByNode(
      authentication.ownerId,
      parsedParams.data.plan_node_id,
    );
    return applyAgentRunSessionRenewal(
      NextResponse.json(presentPosttestAssessmentAttempts(items)),
      authentication,
    );
  } catch (error) {
    return assessmentQueryErrorResponse(error);
  }
}
