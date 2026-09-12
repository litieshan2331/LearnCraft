/**
 * 节点后测生成接口的 HTTP 错误适配器。
 *
 * 导出：
 * - posttestGenerationErrorResponse：将节点、模型连接错误转换为统一 API 响应。
 */

import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/modules/identity/interfaces/auth-http";

import { PosttestGenerationApplicationError } from "../domain/posttest-generation";

export function posttestGenerationErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof PosttestGenerationApplicationError)) {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }

  switch (error.code) {
    case "PLAN_NODE_NOT_FOUND":
      return apiErrorResponse(404, error.code, "节点不存在或你无权访问。");
    case "CARD_CONTENT_NOT_READY":
      return apiErrorResponse(409, error.code, "请先生成该章节的知识内容，再生成后测。");
    case "POSTTEST_GENERATION_IN_PROGRESS":
      return apiErrorResponse(409, error.code, "本章后测正在生成，请先等待当前任务完成。");
    case "POSTTEST_ATTEMPT_REQUIRED":
      return apiErrorResponse(409, error.code, "请先完成当前后测，再生成下一套后测题集。");
    case "DEFAULT_MODEL_CONNECTION_REQUIRED":
      return apiErrorResponse(409, error.code, "请先配置并设置一个账户默认模型连接。");
  }
}