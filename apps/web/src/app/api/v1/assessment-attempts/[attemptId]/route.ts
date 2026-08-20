/**
 * 单次 Assessment 作答详情 Route Handler。
 *
 * 函数：
 * - GET：仅向作答所有者返回提交后的答案、解析与评分详情。
 */

import { NextResponse } from "next/server";

import { getAssessmentAttemptService } from "@/modules/assessment/infrastructure/assessment-attempt-service-factory";
import { assessmentAttemptErrorResponse } from "@/modules/assessment/interfaces/assessment-attempt-http";
import { presentAssessmentAttempt } from "@/modules/assessment/interfaces/assessment-attempt-presenter";
import { assessmentAttemptPathSchema } from "@/modules/assessment/interfaces/assessment-attempt-schemas";
import {
  applyAgentRunSessionRenewal,
  authenticateAgentRunRequest,
} from "@/modules/agent-run/interfaces/agent-run-http";
import { validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ attemptId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const authentication = await authenticateAgentRunRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const params = await context.params;
    const parsedParams = assessmentAttemptPathSchema.safeParse({ attempt_id: params.attemptId });
    if (!parsedParams.success) {
      return applyAgentRunSessionRenewal(validationErrorResponse(parsedParams.error), authentication);
    }

    const attempt = await getAssessmentAttemptService().getOwnedAttempt(
      authentication.ownerId,
      parsedParams.data.attempt_id,
    );
    return applyAgentRunSessionRenewal(NextResponse.json(presentAssessmentAttempt(attempt)), authentication);
  } catch (error) {
    return assessmentAttemptErrorResponse(error);
  }
}
