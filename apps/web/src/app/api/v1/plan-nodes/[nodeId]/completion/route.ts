/**
 * 学习节点完成标记 Route Handler。
 *
 * 函数：
 * - POST：仅记录当前用户对节点的完成标记，不校验前置关系或内容状态。
 */

import { NextResponse } from "next/server";

import {
  applyAgentRunSessionRenewal,
  authenticateAgentRunRequest,
} from "@/modules/agent-run/interfaces/agent-run-http";
import { NodeCompletionServiceError } from "@/modules/planning/domain/node-completion";
import { getNodeCompletionService } from "@/modules/planning/infrastructure/node-completion-service-factory";
import {
  nodeCompletionErrorResponse,
  planNodeCompletionPathSchema,
} from "@/modules/planning/interfaces/node-completion-http";
import { getPlanQueryService } from "@/modules/planning/infrastructure/plan-query-service-factory";
import { presentPlanNode } from "@/modules/planning/interfaces/plan-presenter";
import { apiErrorResponse, validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ nodeId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const authentication = await authenticateAgentRunRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const { nodeId } = await context.params;
    const parsed = planNodeCompletionPathSchema.safeParse({ node_id: nodeId });
    if (!parsed.success) {
      return applyAgentRunSessionRenewal(validationErrorResponse(parsed.error), authentication);
    }

    await getNodeCompletionService().markCompleted({
      ownerId: authentication.ownerId,
      planNodeId: parsed.data.node_id,
    });
    const node = await getPlanQueryService().getOwnedNode(
      authentication.ownerId,
      parsed.data.node_id,
    );
    return applyAgentRunSessionRenewal(
      NextResponse.json(presentPlanNode(node)),
      authentication,
    );
  } catch (error) {
    if (error instanceof NodeCompletionServiceError) {
      return nodeCompletionErrorResponse(error);
    }
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }
}
