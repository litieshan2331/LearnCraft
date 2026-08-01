/**
 * AgentRun Route Handler 的 HTTP 适配器。
 *
 * 导出：
 * - agentRunPathSchema：校验 URL 中的 AgentRun UUID。
 * - authenticateAgentRunRequest：读取当前 Session 并返回任务所有者身份。
 * - applyAgentRunSessionRenewal：在受限滑动续期时写回 Cookie。
 * - agentRunErrorResponse：将 AgentRun 应用错误映射为统一安全响应。
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { clearSessionCookie, getSessionToken, setSessionCookie } from "@/lib/session/session-cookie";
import { AuthenticationError } from "@/modules/identity/domain/authentication";
import { getAuthenticationService } from "@/modules/identity/infrastructure/authentication-service-factory";
import {
  apiErrorResponse,
  authenticationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";

import { AgentRunApplicationError } from "../domain/agent-run";

export const agentRunPathSchema = z.object({
  agent_run_id: z.uuid("AgentRun ID 必须是 UUID。"),
});

export type AgentRunRequestAuthentication =
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

export async function authenticateAgentRunRequest(request: Request): Promise<AgentRunRequestAuthentication> {
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

export function applyAgentRunSessionRenewal(
  response: NextResponse,
  authentication: Extract<AgentRunRequestAuthentication, { authenticated: true }>,
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

export function agentRunErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof AgentRunApplicationError)) {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }

  switch (error.code) {
    case "AGENT_RUN_NOT_FOUND":
      return apiErrorResponse(404, error.code, "任务不存在或你无权访问。");
    case "AGENT_RUN_NOT_CANCELLABLE":
      return apiErrorResponse(409, error.code, "当前任务状态不允许取消。");
    case "IDEMPOTENCY_CONFLICT":
      return apiErrorResponse(409, error.code, "幂等键与已有任务请求不一致。");
  }
}
