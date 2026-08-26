/**
 * 单个学习节点 Route Handler。
 *
 * 函数：
 * - GET：仅向节点所有者返回章节详情、路线状态和前置节点 ID。
 */

import { NextResponse } from "next/server";

import { getPlanQueryService } from "@/modules/planning/infrastructure/plan-query-service-factory";
import {
  planNodePathSchema,
  planQueryErrorResponse,
} from "@/modules/planning/interfaces/plan-query-http";
import { presentPlanNode } from "@/modules/planning/interfaces/plan-presenter";
import {
  applyAgentRunSessionRenewal,
  authenticateAgentRunRequest,
} from "@/modules/agent-run/interfaces/agent-run-http";
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

    const { nodeId } = await context.params;
    const parsedParams = planNodePathSchema.safeParse({ node_id: nodeId });
    if (!parsedParams.success) {
      return applyAgentRunSessionRenewal(
        validationErrorResponse(parsedParams.error),
        authentication,
      );
    }

    const node = await getPlanQueryService().getOwnedNode(
      authentication.ownerId,
      parsedParams.data.node_id,
    );
    return applyAgentRunSessionRenewal(
      NextResponse.json(presentPlanNode(node)),
      authentication,
    );
  } catch (error) {
    return planQueryErrorResponse(error);
  }
}