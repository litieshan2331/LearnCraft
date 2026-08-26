/**
 * 学习计划查询接口的 HTTP 适配器。
 *
 * 导出：
 * - learningPlanPathSchema、planNodePathSchema：校验计划和节点 UUID。
 * - planQueryErrorResponse：映射路线和节点不存在错误。
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/modules/identity/interfaces/auth-http";

import { PlanQueryServiceError } from "../domain/plan-query";

export const learningPlanPathSchema = z.object({
  plan_id: z.uuid("学习计划 ID 必须是 UUID。"),
});

export const planNodePathSchema = z.object({
  node_id: z.uuid("学习节点 ID 必须是 UUID。"),
});

export function planQueryErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof PlanQueryServiceError)) {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }

  switch (error.code) {
    case "LEARNING_PLAN_NOT_FOUND":
      return apiErrorResponse(404, error.code, "学习计划不存在或你无权访问。");
    case "PLAN_NODE_NOT_FOUND":
      return apiErrorResponse(404, error.code, "学习节点不存在或你无权访问。");
  }
}