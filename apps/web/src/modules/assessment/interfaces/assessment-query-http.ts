/**
 * Assessment 题集读取接口的 HTTP 适配器。
 *
 * 导出：
 * - assessmentPathSchema：校验 Assessment UUID 路径参数。
 * - assessmentQueryErrorResponse：将题集读取错误映射为统一 API 响应。
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/modules/identity/interfaces/auth-http";

import { AssessmentQueryApplicationError } from "../domain/assessment-query";

export const assessmentPathSchema = z.object({
  assessment_id: z.uuid("Assessment ID 必须是 UUID。"),
});

export function assessmentQueryErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof AssessmentQueryApplicationError)) {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }

  switch (error.code) {
    case "ASSESSMENT_NOT_FOUND":
      return apiErrorResponse(404, error.code, "题集不存在或你无权访问。");
  }
}
