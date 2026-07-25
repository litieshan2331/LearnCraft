/**
 * 用户登出 Route Handler。
 *
 * 函数：
 * - POST：校验同源，撤销当前服务端 Session 并清除浏览器 Cookie。
 */

import { NextResponse } from "next/server";

import { clearSessionCookie, getSessionToken } from "@/lib/session/session-cookie";
import { getAuthenticationService } from "@/modules/identity/infrastructure/authentication-service-factory";
import {
  assertAllowedWriteOrigin,
  authenticationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) {
    return originError;
  }

  try {
    await getAuthenticationService().logout(getSessionToken(request));
    const response = new NextResponse(null, { status: 204 });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    const response = authenticationErrorResponse(error);
    clearSessionCookie(response);
    return response;
  }
}
