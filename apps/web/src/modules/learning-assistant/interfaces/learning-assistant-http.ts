/**
 * 学习助手 Route Handler 的 HTTP 安全与错误适配器。
 *
 * 调用顺序：Route Handler 调用 authenticateLearningAssistantRequest → 获取 ownerId；
 * 用例抛错后调用 learningAssistantErrorResponse；成功响应调用 applyLearningAssistantSessionRenewal。
 */

import { NextResponse } from "next/server";

import { clearSessionCookie, getSessionToken, setSessionCookie } from "@/lib/session/session-cookie";
import { AuthenticationError } from "@/modules/identity/domain/authentication";
import { getAuthenticationService } from "@/modules/identity/infrastructure/authentication-service-factory";
import {
  apiErrorResponse,
  authenticationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";

import { LearningAssistantApplicationError } from "../application/learning-assistant-service";

export type LearningAssistantRequestAuthentication =
  | {
    authenticated: true;
    ownerId: string;
    rawSessionToken: string;
    renewedSessionExpiresAt: Date | null;
  }
  | { authenticated: false; response: NextResponse };

/** 读取并校验当前登录用户，失败时清除无效 Cookie。 */
export async function authenticateLearningAssistantRequest(
  request: Request,
): Promise<LearningAssistantRequestAuthentication> {
  const rawSessionToken = getSessionToken(request);
  const result = await getAuthenticationService().getCurrentUser(rawSessionToken);
  if (!result || !rawSessionToken) {
    const response = authenticationErrorResponse(new AuthenticationError("UNAUTHORIZED"));
    clearSessionCookie(response);
    return { authenticated: false, response };
  }
  return {
    authenticated: true,
    ownerId: result.user.id,
    rawSessionToken,
    renewedSessionExpiresAt: result.renewedSessionExpiresAt,
  };
}

/** 将认证服务按需续期的 Session 写回响应 Cookie。 */
export function applyLearningAssistantSessionRenewal(
  response: NextResponse,
  authentication: Extract<LearningAssistantRequestAuthentication, { authenticated: true }>,
): NextResponse {
  if (authentication.renewedSessionExpiresAt) {
    setSessionCookie(response, authentication.rawSessionToken, authentication.renewedSessionExpiresAt);
  }
  return response;
}

/** 将应用服务错误转换为稳定的 HTTP 错误契约。 */
export function learningAssistantErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof LearningAssistantApplicationError)) {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }
  switch (error.code) {
    case "CONVERSATION_NOT_FOUND":
      return apiErrorResponse(404, error.code, "学习助手会话不存在或你无权访问。");
    case "RELATED_RESOURCE_NOT_FOUND":
      return apiErrorResponse(422, error.code, "关联的学习目标或测评作答不存在或不属于当前账户。");
    case "CONVERSATION_NOT_ACTIVE":
      return apiErrorResponse(409, error.code, "当前会话已关闭，不能继续发送消息。");
    case "CONVERSATION_BUSY":
      return apiErrorResponse(409, error.code, "当前会话已有消息正在处理，请稍后再试。");
    case "RUN_NOT_FOUND":
      return apiErrorResponse(404, error.code, "对话运行不存在或你无权访问。");
    case "IDEMPOTENCY_CONFLICT":
      return apiErrorResponse(409, error.code, "同一个幂等键不能用于不同的消息请求。");
    case "INVALID_INPUT":
      return apiErrorResponse(422, error.code, "请求参数不符合要求。");
  }
}
