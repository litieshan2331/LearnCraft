/**
 * 学习目标的 plan_generate AgentRun 创建 Route Handler。
 *
 * 函数：
 * - POST：在已评分前测后创建学习路线生成任务。
 */

import { NextResponse } from "next/server";

import { PlanGenerationApplicationError } from "@/modules/planning/domain/plan-generation";
import { getPlanGenerationService } from "@/modules/planning/infrastructure/plan-generation-service-factory";
import { planGenerationErrorResponse } from "@/modules/planning/interfaces/plan-generation-http";
import { planGenerationRequestSchema } from "@/modules/planning/interfaces/plan-generation-schemas";
import {
  agentRunErrorResponse,
  applyAgentRunSessionRenewal,
  authenticateAgentRunRequest,
} from "@/modules/agent-run/interfaces/agent-run-http";
import { presentAgentRun } from "@/modules/agent-run/interfaces/agent-run-presenter";
import {
  assertAllowedWriteOrigin,
  malformedJsonResponse,
  validationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";
import {
  idempotencyKeyErrorResponse,
  idempotencyKeySchema,
  learningGoalPathSchema,
} from "@/modules/profile/interfaces/profile-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ goalId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) {
    return originError;
  }

  const idempotencyKey = request.headers.get("Idempotency-Key");
  const parsedIdempotencyKey = idempotencyKeySchema.safeParse(idempotencyKey);
  if (!parsedIdempotencyKey.success) {
    return idempotencyKeyErrorResponse();
  }

  const { goalId } = await context.params;
  const parsedGoalId = learningGoalPathSchema.safeParse({ goal_id: goalId });
  if (!parsedGoalId.success) {
    return validationErrorResponse(parsedGoalId.error);
  }

  const body = await request.json().catch(() => null);
  if (body === null) {
    return malformedJsonResponse();
  }
  const parsedInput = planGenerationRequestSchema.safeParse(body);
  if (!parsedInput.success) {
    return validationErrorResponse(parsedInput.error);
  }

  try {
    const authentication = await authenticateAgentRunRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const result = await getPlanGenerationService().request({
      ownerId: authentication.ownerId,
      goalId: parsedGoalId.data.goal_id,
      idempotencyKey: parsedIdempotencyKey.data,
    });

    return applyAgentRunSessionRenewal(
      NextResponse.json(presentAgentRun(result.agentRun), { status: result.created ? 202 : 200 }),
      authentication,
    );
  } catch (error) {
    if (error instanceof PlanGenerationApplicationError) {
      return planGenerationErrorResponse(error);
    }
    return agentRunErrorResponse(error);
  }
}