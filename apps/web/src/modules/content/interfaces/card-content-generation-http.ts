/**
 * 节点知识内容生成接口的 HTTP 错误适配器。
 *
 * 导出：
 * - cardContentGenerationErrorResponse：映射节点、内容状态和默认模型连接错误。
 */

import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/modules/identity/interfaces/auth-http";

import { CardContentGenerationApplicationError } from "../domain/content-generation";

export function cardContentGenerationErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof CardContentGenerationApplicationError)) {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }

  switch (error.code) {
    case "PLAN_NODE_NOT_FOUND":
      return apiErrorResponse(404, error.code, "学习章节不存在、路线不是当前有效版本或你无权访问。");
    case "CARD_CONTENT_ALREADY_AVAILABLE":
      return apiErrorResponse(409, error.code, "该章节的知识内容已经生成，请直接查看。");
    case "CARD_CONTENT_GENERATION_IN_PROGRESS":
      return apiErrorResponse(409, error.code, "该章节的知识内容正在生成，请稍后刷新。");
    case "DEFAULT_MODEL_CONNECTION_REQUIRED":
      return apiErrorResponse(409, error.code, "请先配置并设置一个账户默认模型连接。");
  }
}