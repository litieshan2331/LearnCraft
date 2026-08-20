/**
 * Assessment 作答提交接口的 HTTP 错误映射器。
 *
 * 函数：
 * - assessmentAttemptErrorResponse：将作答评分业务错误映射为统一 API 响应。
 * - assessmentSubmissionIdempotencyErrorResponse：返回缺失或非法幂等键错误。
 */

import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/modules/identity/interfaces/auth-http";

import { AssessmentAttemptApplicationError } from "../domain/assessment-attempt";

export function assessmentAttemptErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof AssessmentAttemptApplicationError)) {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }

  switch (error.code) {
    case "ASSESSMENT_NOT_FOUND":
      return apiErrorResponse(404, error.code, "题集不存在或你无权访问。");
    case "ASSESSMENT_ATTEMPT_NOT_FOUND":
      return apiErrorResponse(404, error.code, "作答记录不存在或你无权访问。");
    case "ASSESSMENT_NOT_SUBMITTABLE":
      return apiErrorResponse(409, error.code, "当前题集尚不可提交或已经结束。");
    case "ASSESSMENT_ALREADY_SUBMITTED":
      return apiErrorResponse(409, error.code, "这份题集已经提交，不能重复作答。");
    case "ASSESSMENT_ANSWERS_INVALID":
      return apiErrorResponse(422, error.code, "请完整且正确地提交本题集的所有答案。", [
        { field: "answers", message: "答案必须覆盖题集中的每一道题，且只能使用该题已有选项。" },
      ]);
    case "IDEMPOTENCY_CONFLICT":
      return apiErrorResponse(409, error.code, "同一个幂等键不能用于不同的作答请求。");
  }
}

export function assessmentSubmissionIdempotencyErrorResponse(): NextResponse {
  return apiErrorResponse(422, "VALIDATION_ERROR", "请求参数不符合要求。", [
    { field: "Idempotency-Key", message: "请提供合法的 UUID 幂等键。" },
  ]);
}
