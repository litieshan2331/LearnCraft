/**
 * 节点知识内容查询接口的 HTTP 适配器。
 *
 * 导出：
 * - cardContentPathSchema：校验内容 ID。
 * - cardContentQueryErrorResponse：映射内容不存在或无权访问错误。
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/modules/identity/interfaces/auth-http";

import { CardContentQueryServiceError } from "../domain/content-query";

export const cardContentPathSchema = z.object({
  card_content_id: z.uuid("节点知识内容 ID 必须是 UUID。"),
});

export function cardContentQueryErrorResponse(error: unknown): NextResponse {
  if (error instanceof CardContentQueryServiceError && error.code === "CARD_CONTENT_NOT_FOUND") {
    return apiErrorResponse(404, error.code, "节点知识内容不存在或你无权访问。");
  }
  return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
}