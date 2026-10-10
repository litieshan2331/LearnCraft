/**
 * 学习助手会话集合 Route Handler。
 *
 * 函数：GET 读取当前用户会话列表；POST 创建会话。Route 只负责 Session、参数校验和
 * 响应映射，具体所有权与关联资源校验由应用服务和 Repository 完成。
 */

import { NextResponse } from "next/server";

import { getLearningAssistantService } from "@/modules/learning-assistant/infrastructure/learning-assistant-service-factory";
import { presentConversation } from "@/modules/learning-assistant/interfaces/learning-assistant-presenter";
import {
  createConversationRequestSchema,
  parseConversationListQuery,
} from "@/modules/learning-assistant/interfaces/learning-assistant-schemas";
import {
  applyLearningAssistantSessionRenewal,
  authenticateLearningAssistantRequest,
  learningAssistantErrorResponse,
} from "@/modules/learning-assistant/interfaces/learning-assistant-http";
import {
  assertAllowedWriteOrigin,
  malformedJsonResponse,
  validationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 读取当前用户的学习助手会话列表。 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const authentication = await authenticateLearningAssistantRequest(request);
    if (!authentication.authenticated) return authentication.response;
    const parsed = parseConversationListQuery(new URL(request.url).searchParams);
    if (!parsed.success) {
      return applyLearningAssistantSessionRenewal(validationErrorResponse(parsed.error), authentication);
    }
    const conversations = await getLearningAssistantService().listConversations(
      authentication.ownerId,
      parsed.data.limit,
    );
    return applyLearningAssistantSessionRenewal(
      NextResponse.json({ items: conversations.map(presentConversation) }),
      authentication,
    );
  } catch (error) {
    return learningAssistantErrorResponse(error);
  }
}

/** 创建一个学习助手会话，goal_id 和来源测评作答都可为空。 */
export async function POST(request: Request): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) return originError;
  const body = await request.json().catch(() => null);
  if (body === null) return malformedJsonResponse();
  const parsedBody = createConversationRequestSchema.safeParse(body);
  if (!parsedBody.success) return validationErrorResponse(parsedBody.error);
  try {
    const authentication = await authenticateLearningAssistantRequest(request);
    if (!authentication.authenticated) return authentication.response;
    const conversation = await getLearningAssistantService().createConversation({
      ownerId: authentication.ownerId,
      goalId: parsedBody.data.goal_id,
      sourceAssessmentAnswerId: parsedBody.data.source_assessment_answer_id,
    });
    return applyLearningAssistantSessionRenewal(
      NextResponse.json(presentConversation(conversation), { status: 201 }),
      authentication,
    );
  } catch (error) {
    return learningAssistantErrorResponse(error);
  }
}
