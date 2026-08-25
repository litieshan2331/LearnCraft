/**
 * 学习路线生成接口的 HTTP 错误适配器。
 *
 * 导出：
 * - planGenerationErrorResponse：映射路线前置条件与默认模型连接错误。
 */

import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/modules/identity/interfaces/auth-http";

import { PlanGenerationApplicationError } from "../domain/plan-generation";

export function planGenerationErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof PlanGenerationApplicationError)) {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }

  switch (error.code) {
    case "PLAN_GENERATION_PREREQUISITES_NOT_MET":
      return apiErrorResponse(
        409,
        error.code,
        "请先完成当前学习目标的前测评分，再生成学习路线。",
      );
    case "DEFAULT_MODEL_CONNECTION_REQUIRED":
      return apiErrorResponse(409, error.code, "请先配置并设置一个账户默认模型连接。");
  }
}