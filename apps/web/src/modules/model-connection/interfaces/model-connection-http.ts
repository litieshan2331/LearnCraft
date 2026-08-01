/**
 * 用户模型连接 Route Handler 的 HTTP 安全适配器。
 *
 * 导出：
 * - authenticateModelConnectionRequest：读取当前 Session 并返回连接所有者身份。
 * - applyModelConnectionSessionRenewal：在受限滑动续期时写回 Cookie。
 * - modelConnectionErrorResponse：映射模型连接应用错误为安全 API 响应。
 */

import { NextResponse } from "next/server";

import { clearSessionCookie, getSessionToken, setSessionCookie } from "@/lib/session/session-cookie";
import { AuthenticationError } from "@/modules/identity/domain/authentication";
import { getAuthenticationService } from "@/modules/identity/infrastructure/authentication-service-factory";
import {
  apiErrorResponse,
  authenticationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";

import { ModelConnectionApplicationError } from "../domain/model-connection";

export type ModelConnectionRequestAuthentication =
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

export async function authenticateModelConnectionRequest(
  request: Request,
): Promise<ModelConnectionRequestAuthentication> {
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

export function applyModelConnectionSessionRenewal(
  response: NextResponse,
  authentication: Extract<ModelConnectionRequestAuthentication, { authenticated: true }>,
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

export function modelConnectionErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof ModelConnectionApplicationError)) {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }

  switch (error.code) {
    case "MODEL_CONNECTION_NOT_FOUND":
      return apiErrorResponse(404, error.code, "模型连接不存在或你无权访问。");
    case "MODEL_CONNECTION_NAME_CONFLICT":
      return apiErrorResponse(409, error.code, "该连接名称已存在，请更换名称。");
    case "INVALID_BASE_URL":
      return apiErrorResponse(422, error.code, "Base URL 必须是有效的 HTTP 或 HTTPS 地址，且不能含认证信息、查询参数或片段。");
    case "CREDENTIAL_ENCRYPTION_UNAVAILABLE":
      return apiErrorResponse(503, error.code, "模型凭据加密服务尚未配置，请稍后重试。");
  }
}
