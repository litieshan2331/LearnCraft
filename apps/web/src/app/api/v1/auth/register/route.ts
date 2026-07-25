/**
 * 用户注册 Route Handler。
 *
 * 函数：
 * - POST：校验同源与输入，仅创建用户；注册成功不创建 Session 或设置 Cookie。
 */

import { NextResponse } from "next/server";

import { getAuthenticationService } from "@/modules/identity/infrastructure/authentication-service-factory";
import {
  assertAllowedWriteOrigin,
  authenticationErrorResponse,
  getAuthenticationRequestMetadata,
  malformedJsonResponse,
  validationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";
import { registerRequestSchema } from "@/modules/identity/interfaces/auth-schemas";

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

  const parsedInput = registerRequestSchema.safeParse(body);
  if (!parsedInput.success) {
    return validationErrorResponse(parsedInput.error);
  }

  try {
    const result = await getAuthenticationService().register({
      email: parsedInput.data.email,
      displayName: parsedInput.data.display_name,
      password: parsedInput.data.password,
    }, getAuthenticationRequestMetadata(request));
    return NextResponse.json({
      id: result.id,
      email: result.email,
      display_name: result.displayName,
    }, { status: 201 });
  } catch (error) {
    return authenticationErrorResponse(error);
  }
}
