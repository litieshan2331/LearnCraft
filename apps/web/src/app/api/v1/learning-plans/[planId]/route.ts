/**
 * 单个学习计划 Route Handler。
 *
 * 函数：
 * - GET：仅向计划所有者返回完整路线、章节和前置节点 ID。
 */

import { NextResponse } from "next/server";

import { getPlanQueryService } from "@/modules/planning/infrastructure/plan-query-service-factory";
import {
  learningPlanPathSchema,
  planQueryErrorResponse,
} from "@/modules/planning/interfaces/plan-query-http";
import { presentLearningPlan } from "@/modules/planning/interfaces/plan-presenter";
import {
  applyAgentRunSessionRenewal,
  authenticateAgentRunRequest,
} from "@/modules/agent-run/interfaces/agent-run-http";
import { validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ planId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const authentication = await authenticateAgentRunRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const { planId } = await context.params;
    const parsedParams = learningPlanPathSchema.safeParse({ plan_id: planId });
    if (!parsedParams.success) {
      return applyAgentRunSessionRenewal(
        validationErrorResponse(parsedParams.error),
        authentication,
      );
    }

    const plan = await getPlanQueryService().getOwnedPlan(
      authentication.ownerId,
      parsedParams.data.plan_id,
    );
    return applyAgentRunSessionRenewal(
      NextResponse.json(presentLearningPlan(plan)),
      authentication,
    );
  } catch (error) {
    return planQueryErrorResponse(error);
  }
}