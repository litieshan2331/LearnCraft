/**
 * 学习目标的 assessment_generate AgentRun 创建 Route Handler。
 *
 * 函数：
 * - POST：为当前用户的学习目标创建前测或后测生成任务，并返回可轮询的 AgentRun 快照。
 */

import { NextResponse } from "next/server";

import { getAssessmentGenerationService } from "@/modules/assessment/infrastructure/assessment-generation-service-factory";
import { assessmentGenerationErrorResponse } from "@/modules/assessment/interfaces/assessment-generation-http";
import { assessmentGenerationRequestSchema } from "@/modules/assessment/interfaces/assessment-generation-schemas";
import {
  AssessmentGenerationApplicationError,
} from "@/modules/assessment/domain/assessment-generation";
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
import { idempotencyKeyErrorResponse, idempotencyKeySchema, learningGoalPathSchema } from "@/modules/profile/interfaces/profile-http";

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

  const params = await context.params;
  const parsedGoalId = learningGoalPathSchema.safeParse({ goal_id: params.goalId });
  if (!parsedGoalId.success) {
    return validationErrorResponse(parsedGoalId.error);
  }

  const body = await request.json().catch(() => null);
  if (body === null) {
    return malformedJsonResponse();
  }

  const parsedInput = assessmentGenerationRequestSchema.safeParse(body);
  if (!parsedInput.success) {
    return validationErrorResponse(parsedInput.error);
  }

  try {
    const authentication = await authenticateAgentRunRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const result = await getAssessmentGenerationService().request({
      ownerId: authentication.ownerId,
      goalId: parsedGoalId.data.goal_id,
      kind: parsedInput.data.kind,
      questionCount: parsedInput.data.question_count,
      difficulty: parsedInput.data.difficulty,
      planId: parsedInput.data.plan_id,
      idempotencyKey: parsedIdempotencyKey.data,
    });

    return applyAgentRunSessionRenewal(
      NextResponse.json(presentAgentRun(result.agentRun), { status: result.created ? 202 : 200 }),
      authentication,
    );
  } catch (error) {
    if (error instanceof AssessmentGenerationApplicationError) {
      return assessmentGenerationErrorResponse(error);
    }
    return agentRunErrorResponse(error);
  }
}
