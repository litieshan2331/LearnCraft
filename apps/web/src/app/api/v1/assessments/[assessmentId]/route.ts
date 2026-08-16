/**
 * 单个 Assessment 题集读取 Route Handler。
 *
 * 函数：
 * - GET：仅向题集所有者返回不含答案、解析和评分内部字段的题目列表。
 */

import { NextResponse } from "next/server";

import { getAssessmentQueryService } from "@/modules/assessment/infrastructure/assessment-query-service-factory";
import {
  assessmentPathSchema,
  assessmentQueryErrorResponse,
} from "@/modules/assessment/interfaces/assessment-query-http";
import { presentAssessment } from "@/modules/assessment/interfaces/assessment-presenter";
import {
  applyAgentRunSessionRenewal,
  authenticateAgentRunRequest,
} from "@/modules/agent-run/interfaces/agent-run-http";
import { validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ assessmentId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const authentication = await authenticateAgentRunRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const params = await context.params;
    const parsedParams = assessmentPathSchema.safeParse({ assessment_id: params.assessmentId });
    if (!parsedParams.success) {
      return applyAgentRunSessionRenewal(
        validationErrorResponse(parsedParams.error),
        authentication,
      );
    }

    const assessment = await getAssessmentQueryService().getOwnedAssessment(
      authentication.ownerId,
      parsedParams.data.assessment_id,
    );
    return applyAgentRunSessionRenewal(NextResponse.json(presentAssessment(assessment)), authentication);
  } catch (error) {
    return assessmentQueryErrorResponse(error);
  }
}
