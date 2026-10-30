/**
 * 学习助手回答流式输出 Route Handler。
 *
 * 调用顺序：校验登录态和 runId → 校验运行归属 → 订阅 Worker 的临时进度频道 →
 * 将事件包装为 SSE 响应；订阅不可用时由 SSE 适配器保持连接，客户端继续状态轮询。
 */

import { NextResponse } from "next/server";

import { subscribeAgentProgress } from "@/modules/agent-run/infrastructure/agent-progress-subscriber";
import { createAgentProgressSseResponse } from "@/modules/agent-run/interfaces/agent-progress-sse";
import { getLearningAssistantService } from "@/modules/learning-assistant/infrastructure/learning-assistant-service-factory";
import {
  applyLearningAssistantSessionRenewal,
  authenticateLearningAssistantRequest,
  learningAssistantErrorResponse,
} from "@/modules/learning-assistant/interfaces/learning-assistant-http";
import { runPathSchema } from "@/modules/learning-assistant/interfaces/learning-assistant-schemas";
import { validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ runId: string }>;
}

/** 仅允许运行所有者订阅该运行的临时进度事件。 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const authentication = await authenticateLearningAssistantRequest(request);
    if (!authentication.authenticated) return authentication.response;

    const params = await context.params;
    const parsedParams = runPathSchema.safeParse({ run_id: params.runId });
    if (!parsedParams.success) {
      return applyLearningAssistantSessionRenewal(
        validationErrorResponse(parsedParams.error),
        authentication,
      );
    }

    await getLearningAssistantService().getRun(authentication.ownerId, parsedParams.data.run_id);
    const response = createAgentProgressSseResponse({
      runId: parsedParams.data.run_id,
      subscribe: (input) => subscribeAgentProgress(input),
      signal: request.signal,
    });
    return applyLearningAssistantSessionRenewal(response, authentication);
  } catch (error) {
    return learningAssistantErrorResponse(error);
  }
}
