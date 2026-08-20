/**
 * Assessment 作答提交和历史列表 Route Handler。
 *
 * 函数：
 * - GET：返回当前用户在指定题集下已评分的作答摘要。
 * - POST：保存完整选择答案、同步完成确定性评分并返回解析。
 */

import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { getAssessmentAttemptService } from "@/modules/assessment/infrastructure/assessment-attempt-service-factory";
import {
  assessmentAttemptErrorResponse,
  assessmentSubmissionIdempotencyErrorResponse,
} from "@/modules/assessment/interfaces/assessment-attempt-http";
import { presentAssessmentAttempt, presentAssessmentAttemptSummary } from "@/modules/assessment/interfaces/assessment-attempt-presenter";
import {
  assessmentAttemptSubmissionRequestSchema,
  assessmentSubmissionIdempotencyKeySchema,
} from "@/modules/assessment/interfaces/assessment-attempt-schemas";
import { assessmentPathSchema } from "@/modules/assessment/interfaces/assessment-query-http";
import {
  applyAgentRunSessionRenewal,
  authenticateAgentRunRequest,
} from "@/modules/agent-run/interfaces/agent-run-http";
import {
  assertAllowedWriteOrigin,
  malformedJsonResponse,
  validationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";

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
      return applyAgentRunSessionRenewal(validationErrorResponse(parsedParams.error), authentication);
    }

    const attempts = await getAssessmentAttemptService().listOwnedAttempts(
      authentication.ownerId,
      parsedParams.data.assessment_id,
    );
    return applyAgentRunSessionRenewal(
      NextResponse.json({ items: attempts.map(presentAssessmentAttemptSummary) }),
      authentication,
    );
  } catch (error) {
    return assessmentAttemptErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) {
    return originError;
  }

  const idempotencyKey = assessmentSubmissionIdempotencyKeySchema.safeParse(
    request.headers.get("Idempotency-Key"),
  );
  if (!idempotencyKey.success) {
    return assessmentSubmissionIdempotencyErrorResponse();
  }

  const body = await request.json().catch(() => null);
  if (body === null) {
    return malformedJsonResponse();
  }
  const parsedBody = assessmentAttemptSubmissionRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return validationErrorResponse(parsedBody.error);
  }

  try {
    const authentication = await authenticateAgentRunRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const params = await context.params;
    const parsedParams = assessmentPathSchema.safeParse({ assessment_id: params.assessmentId });
    if (!parsedParams.success) {
      return applyAgentRunSessionRenewal(validationErrorResponse(parsedParams.error), authentication);
    }

    const result = await getAssessmentAttemptService().submit({
      ownerId: authentication.ownerId,
      assessmentId: parsedParams.data.assessment_id,
      idempotencyKey: idempotencyKey.data,
      requestHash: createSubmissionRequestHash(parsedParams.data.assessment_id, parsedBody.data.answers),
      answers: parsedBody.data.answers.map((answer) => ({
        assessmentItemId: answer.assessment_item_id,
        selectedOptionKey: answer.selected_option_key,
      })),
    });
    return applyAgentRunSessionRenewal(
      NextResponse.json(presentAssessmentAttempt(result.attempt), { status: result.created ? 201 : 200 }),
      authentication,
    );
  } catch (error) {
    return assessmentAttemptErrorResponse(error);
  }
}

function createSubmissionRequestHash(
  assessmentId: string,
  answers: Array<{ assessment_item_id: string; selected_option_key: string }>,
): string {
  const canonicalAnswers = [...answers]
    .sort((left, right) => left.assessment_item_id.localeCompare(right.assessment_item_id))
    .map((answer) => [answer.assessment_item_id, answer.selected_option_key]);
  return createHash("sha256")
    .update(JSON.stringify({ assessment_id: assessmentId, answers: canonicalAnswers }))
    .digest("hex");
}
