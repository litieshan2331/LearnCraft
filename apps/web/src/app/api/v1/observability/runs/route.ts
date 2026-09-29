/**
 * 当前用户 Agent 观测运行列表接口。
 *
 * 调用顺序：GET 校验 Session 与过滤参数，按 owner_id 查询稳定游标页并返回摘要。
 */

import { NextResponse } from "next/server";

import { listTraceRuns } from "@/modules/agent-run/infrastructure/agent-trace-query";
import { applyAgentRunSessionRenewal, authenticateAgentRunRequest } from "@/modules/agent-run/interfaces/agent-run-http";
import { encodeTraceRunCursor, parseTraceRunListQuery, presentTraceRun } from "@/modules/agent-run/interfaces/agent-trace-http";
import { apiErrorResponse, validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 按创建时间和运行 ID 的复合游标分页查询当前用户运行。 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const auth = await authenticateAgentRunRequest(request);
    if (!auth.authenticated) return auth.response;

    const parsed = parseTraceRunListQuery(new URL(request.url).searchParams);
    if (!parsed.success) {
      const response = typeof parsed.error === "string"
        ? apiErrorResponse(422, "VALIDATION_ERROR", "运行列表游标无效。")
        : validationErrorResponse(parsed.error);
      return applyAgentRunSessionRenewal(response, auth);
    }

    const page = await listTraceRuns({ ...parsed.data, ownerId: auth.ownerId });
    const last = page.items.at(-1);
    return applyAgentRunSessionRenewal(NextResponse.json({
      items: page.items.map(presentTraceRun),
      next_cursor: page.hasMore && last
        ? encodeTraceRunCursor({ createdAt: last.createdAt, id: last.id })
        : null,
    }), auth);
  } catch {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }
}
