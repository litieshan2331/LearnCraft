/**
 * Profile Route Handler 的 HTTP 安全适配器。
 *
 * 导出：
 * - authenticateProfileRequest：读取当前 Session 并返回目标资源所有者。
 * - applyProfileSessionRenewal：在需要时续期 Session Cookie。
 * - profileErrorResponse、idempotencyKeyErrorResponse：映射画像与目标的稳定 API 错误。
 */

import { NextResponse } from "next/server";

import { clearSessionCookie, getSessionToken, setSessionCookie } from "@/lib/session/session-cookie";
import { AuthenticationError } from "@/modules/identity/domain/authentication";
import { getAuthenticationService } from "@/modules/identity/infrastructure/authentication-service-factory";
import {
  apiErrorResponse,
  authenticationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";

import { ProfileApplicationError } from "../domain/profile";

export type ProfileRequestAuthentication =
  | {
    authenticated: true;
    ownerId: string;
    rawSessionToken: string;
    renewedSessionExpiresAt: Date | null;
  }
  | {
    authenticated: false;
    response: NextResponse;
  };

export async function authenticateProfileRequest(request: Request): Promise<ProfileRequestAuthentication> {
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

export function applyProfileSessionRenewal(
  response: NextResponse,
  authentication: Extract<ProfileRequestAuthentication, { authenticated: true }>,
): NextResponse {
  if (authentication.renewedSessionExpiresAt) {
    setSessionCookie(
      response,
      authentication.rawSessionToken,
      authentication.renewedSessionExpiresAt,
    );
  }

  return response;
}

export function profileErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof ProfileApplicationError)) {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }

  switch (error.code) {
    case "PROFILE_REQUIRED":
      return apiErrorResponse(409, error.code, "请先完成学习画像，再创建学习目标。");
    case "MODEL_CONNECTION_NOT_FOUND":
      return apiErrorResponse(422, error.code, "所选模型连接不可用或不属于当前账户。", [
        { field: "model_connection_id", message: "请选择当前账户中可用的模型连接。" },
      ]);
    case "LEARNING_GOAL_NOT_FOUND":
      return apiErrorResponse(404, error.code, "学习目标不存在或你无权访问。");
    case "GOAL_HAS_ACTIVE_RUNS":
      return apiErrorResponse(409, error.code, "学习目标仍有运行中的任务，请先取消任务后再删除。");
    case "IDEMPOTENCY_CONFLICT":
      return apiErrorResponse(409, error.code, "同一个幂等键不能用于不同的学习目标请求。");
  }
}

export function idempotencyKeyErrorResponse(): NextResponse {
  return apiErrorResponse(422, "VALIDATION_ERROR", "请求参数不符合要求。", [
    { field: "Idempotency-Key", message: "请提供合法的 UUID 幂等键。" },
  ]);
}
export { idempotencyKeySchema, learningGoalPathSchema } from './profile-schemas';
