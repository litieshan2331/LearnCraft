/**
 * 学习助手会话消息 Route Handler。
 *
 * 函数：GET 按序号游标读取全部持久化消息；POST 原子保存用户消息并创建 queued 运行。
 * POST 不在 Web 请求内调用模型，后续由队列与 Agent Worker 执行。
 */

import { NextResponse } from "next/server";

import { getLearningAssistantService } from "@/modules/learning-assistant/infrastructure/learning-assistant-service-factory";
import { presentMessage, presentRun } from "@/modules/learning-assistant/interfaces/learning-assistant-presenter";
import {
  conversationPathSchema,
  parseMessageListQuery,
  sendMessageHeadersSchema,
  sendMessageRequestSchema,
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

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

/** 读取当前用户会话的全部消息历史；使用 after_sequence_no 分页。 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const authentication = await authenticateLearningAssistantRequest(request);
    if (!authentication.authenticated) return authentication.response;
    const params = await context.params;
    const parsedParams = conversationPathSchema.safeParse({ conversation_id: params.conversationId });
    if (!parsedParams.success) {
      return applyLearningAssistantSessionRenewal(validationErrorResponse(parsedParams.error), authentication);
    }
    const parsedQuery = parseMessageListQuery(new URL(request.url).searchParams);
    if (!parsedQuery.success) {
      return applyLearningAssistantSessionRenewal(validationErrorResponse(parsedQuery.error), authentication);
    }
    const page = await getLearningAssistantService().listMessages(
      authentication.ownerId,
      parsedParams.data.conversation_id,
      parsedQuery.data,
    );
    return applyLearningAssistantSessionRenewal(NextResponse.json({
      items: page.items.map(presentMessage),
      next_after_sequence_no: page.nextAfterSequenceNo,
    }), authentication);
  } catch (error) {
    return learningAssistantErrorResponse(error);
  }
}

/** 发送一条用户消息并创建排队中的对话运行。 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) return originError;
  const parsedHeaders = sendMessageHeadersSchema.safeParse({
    "Idempotency-Key": request.headers.get("Idempotency-Key"),
  });
  if (!parsedHeaders.success) {
    return validationErrorResponse(parsedHeaders.error);
  }
  const body = await request.json().catch(() => null);
  if (body === null) return malformedJsonResponse();
  const parsedBody = sendMessageRequestSchema.safeParse(body);
  if (!parsedBody.success) return validationErrorResponse(parsedBody.error);
  try {
    const authentication = await authenticateLearningAssistantRequest(request);
    if (!authentication.authenticated) return authentication.response;
    const params = await context.params;
    const parsedParams = conversationPathSchema.safeParse({ conversation_id: params.conversationId });
    if (!parsedParams.success) {
      return applyLearningAssistantSessionRenewal(validationErrorResponse(parsedParams.error), authentication);
    }
    const result = await getLearningAssistantService().sendMessage({
      ownerId: authentication.ownerId,
      conversationId: parsedParams.data.conversation_id,
      idempotencyKey: parsedHeaders.data["Idempotency-Key"],
      content: parsedBody.data.content,
    });
    return applyLearningAssistantSessionRenewal(NextResponse.json({
      message: presentMessage(result.message),
      run: presentRun(result.run),
      created: result.created,
    }, { status: result.created ? 202 : 200 }), authentication);
  } catch (error) {
    return learningAssistantErrorResponse(error);
  }
}
