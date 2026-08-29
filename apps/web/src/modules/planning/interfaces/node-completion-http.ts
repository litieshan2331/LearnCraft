/**
 * 学习节点完成标记接口的 HTTP 适配器。
 *
 * 导出：
 * - planNodeCompletionPathSchema：校验节点 UUID。
 * - nodeCompletionErrorResponse：映射节点不存在或无权访问错误。
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/modules/identity/interfaces/auth-http";

import { NodeCompletionServiceError } from "../domain/node-completion";

export const planNodeCompletionPathSchema = z.object({
  node_id: z.uuid("学习节点 ID 必须是 UUID。"),
});

export function nodeCompletionErrorResponse(error: unknown): NextResponse {
  if (error instanceof NodeCompletionServiceError && error.code === "PLAN_NODE_NOT_FOUND") {
    return apiErrorResponse(404, error.code, "学习节点不存在或你无权访问。");
  }
  return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
}