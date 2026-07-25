/**
 * 用户登录 Route Handler。
 *
 * 函数：
 * - POST：校验同源与凭据，创建新的不透明 Session，并设置 HttpOnly Cookie。
 */

import { NextResponse } from "next/server";

import { setSessionCookie } from "@/lib/session/session-cookie";
import { getAuthenticationService } from "@/modules/identity/infrastructure/authentication-service-factory";
import {
  assertAllowedWriteOrigin,
  authenticationErrorResponse,
  getAuthenticationRequestMetadata,
  malformedJsonResponse,
  validationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";
import { loginRequestSchema } from "@/modules/identity/interfaces/auth-schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) {
    return originError;
  }

  const body = await request.json().catch(() => null);
  if (body === null) {
    return malformedJsonResponse();
  }

  const parsedInput = loginRequestSchema.safeParse(body);
  if (!parsedInput.success) {
    return validationErrorResponse(parsedInput.error);
  }

  try {
    const result = await getAuthenticationService().login({
      email: parsedInput.data.email,
      password: parsedInput.data.password,
    }, getAuthenticationRequestMetadata(request));
    const response = NextResponse.json({
      id: result.user.id,
      email: result.user.email,
      display_name: result.user.displayName,
    });

    setSessionCookie(response, result.rawSessionToken, result.expiresAt);
    return response;
  } catch (error) {
    return authenticationErrorResponse(error);
  }
}
