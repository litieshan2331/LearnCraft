/**
 * 当前用户 Route Handler。
 *
 * 函数：
 * - GET：读取当前不透明 Session，按需受限滑动续期，并返回当前用户资料完成状态。
 */

import { NextResponse } from "next/server";

import { clearSessionCookie, getSessionToken, setSessionCookie } from "@/lib/session/session-cookie";
import { AuthenticationError } from "@/modules/identity/domain/authentication";
import { getAuthenticationService } from "@/modules/identity/infrastructure/authentication-service-factory";
import { authenticationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const rawSessionToken = getSessionToken(request);
    const result = await getAuthenticationService().getCurrentUser(rawSessionToken);

    if (!result) {
      const response = authenticationErrorResponse(new AuthenticationError("UNAUTHORIZED"));
      clearSessionCookie(response);
      return response;
    }

    const response = NextResponse.json({
      id: result.user.id,
      email: result.user.email,
      display_name: result.user.displayName,
      profile_completed: result.user.profileCompleted,
    });

    if (result.renewedSessionExpiresAt && rawSessionToken) {
      setSessionCookie(response, rawSessionToken, result.renewedSessionExpiresAt);
    }

    return response;
  } catch (error) {
    return authenticationErrorResponse(error);
  }
}
