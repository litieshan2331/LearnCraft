/**
 * 单个学习助手会话 Route Handler。
 *
 * 函数：GET 读取当前用户拥有的会话详情；路径与 Session 由 Route 校验，所有权由应用服务校验。
 */

import { NextResponse } from "next/server";

import { getLearningAssistantService } from "@/modules/learning-assistant/infrastructure/learning-assistant-service-factory";
import { presentConversation } from "@/modules/learning-assistant/interfaces/learning-assistant-presenter";
import { conversationPathSchema } from "@/modules/learning-assistant/interfaces/learning-assistant-schemas";
import {
  applyLearningAssistantSessionRenewal,
  authenticateLearningAssistantRequest,
  learningAssistantErrorResponse,
} from "@/modules/learning-assistant/interfaces/learning-assistant-http";
import { validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

/** 读取当前用户拥有的单个学习助手会话。 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const authentication = await authenticateLearningAssistantRequest(request);
    if (!authentication.authenticated) return authentication.response;
    const params = await context.params;
    const parsedParams = conversationPathSchema.safeParse({ conversation_id: params.conversationId });
    if (!parsedParams.success) {
      return applyLearningAssistantSessionRenewal(validationErrorResponse(parsedParams.error), authentication);
    }
    const detail = await getLearningAssistantService().getConversation(
      authentication.ownerId,
      parsedParams.data.conversation_id,
    );
    return applyLearningAssistantSessionRenewal(
      NextResponse.json({
        ...presentConversation(detail.conversation),
        active_run_id: detail.activeRun?.id ?? null,
      }),
      authentication,
    );
  } catch (error) {
    return learningAssistantErrorResponse(error);
  }
}
