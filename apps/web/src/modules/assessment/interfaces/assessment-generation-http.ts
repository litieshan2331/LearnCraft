/**
 * Assessment 生成接口的 HTTP 错误适配器。
 *
 * 导出：
 * - assessmentGenerationErrorResponse：将目标、路线和默认模型错误转换为统一 API 响应。
 */

import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/modules/identity/interfaces/auth-http";

import { AssessmentGenerationApplicationError } from "../domain/assessment-generation";

export function assessmentGenerationErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof AssessmentGenerationApplicationError)) {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }

  switch (error.code) {
    case "LEARNING_GOAL_NOT_FOUND":
      return apiErrorResponse(404, error.code, "学习目标不存在或你无权访问。");
    case "LEARNING_PLAN_NOT_FOUND":
      return apiErrorResponse(422, error.code, "学习路线不存在或不属于当前学习目标。", [
        { field: "plan_id", message: "请选择当前学习目标下的有效学习路线。" },
      ]);
    case "DEFAULT_MODEL_CONNECTION_REQUIRED":
      return apiErrorResponse(409, error.code, "请先配置并设置一个账户默认模型连接。");
  }
}
