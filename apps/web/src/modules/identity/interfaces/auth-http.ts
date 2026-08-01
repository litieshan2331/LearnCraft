/**
 * Identity Route Handler 共用的 HTTP 安全适配器。
 *
 * 导出：
 * - assertAllowedWriteOrigin：校验写请求 Origin 是否在已批准 Web 来源内。
 * - getAuthenticationRequestMetadata：提取并哈希客户端 IP 与 User-Agent。
 * - apiErrorResponse、authenticationErrorResponse、validationErrorResponse：生成统一安全错误响应。
 */

import { createHash, randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import type { z } from "zod";

import type { AuthenticationRequestMetadata } from "../application/authentication-service";
import { AuthenticationError } from "../domain/authentication";

interface FieldError {
  field: string;
  message: string;
}

export function assertAllowedWriteOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin || !getAllowedOrigins().has(origin)) {
    return authenticationErrorResponse(new AuthenticationError("INVALID_ORIGIN"));
  }

  return null;
}

export function getAuthenticationRequestMetadata(request: Request): AuthenticationRequestMetadata {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const clientAddress = forwardedFor?.split(",", 1)[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown";
  const userAgent = request.headers.get("user-agent")?.trim().slice(0, 500) || null;

  return {
    clientIpHash: createHash("sha256").update(clientAddress).digest("hex"),
    userAgent,
  };
}

export function validationErrorResponse(error: z.ZodError): NextResponse {
  const fieldErrors: FieldError[] = error.issues.map((issue) => ({
    field: issue.path.join(".") || "body",
    message: issue.message,
  }));

  return apiErrorResponse(422, "VALIDATION_ERROR", "请求参数不符合要求。", fieldErrors);
}

export function malformedJsonResponse(): NextResponse {
  return apiErrorResponse(422, "VALIDATION_ERROR", "请求体必须是合法的 JSON 对象。", [
    { field: "body", message: "请求体不是合法 JSON。" },
  ]);
}

export function authenticationErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof AuthenticationError)) {
    return apiErrorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。");
  }

  switch (error.code) {
    case "EMAIL_ALREADY_EXISTS":
      return apiErrorResponse(409, error.code, "该邮箱已被注册。");
    case "INVALID_CREDENTIALS":
      return apiErrorResponse(401, error.code, "邮箱或密码错误。");
    case "UNAUTHORIZED":
      return apiErrorResponse(401, error.code, "登录状态无效或已过期。");
    case "INVALID_ORIGIN":
      return apiErrorResponse(403, error.code, "请求来源不被允许。");
    case "RATE_LIMITED":
      return apiErrorResponse(429, error.code, "请求过于频繁，请稍后再试。", undefined, error.retryAfterSeconds);
    case "AUTH_RATE_LIMIT_UNAVAILABLE":
      return apiErrorResponse(503, error.code, "认证限流服务暂时不可用，请稍后重试。");
  }
}

export function apiErrorResponse(
  status: number,
  code: string,
  message: string,
  fieldErrors?: FieldError[],
  retryAfterSeconds?: number,
): NextResponse {
  const response = NextResponse.json({
    error: {
      code,
      message,
      trace_id: randomUUID(),
      ...(fieldErrors ? { field_errors: fieldErrors } : {}),
    },
  }, { status });

  if (retryAfterSeconds) {
    response.headers.set("Retry-After", String(retryAfterSeconds));
  }

  return response;
}

function getAllowedOrigins(): Set<string> {
  const configuredOrigins = process.env.APP_ORIGIN?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (!configuredOrigins?.length) {
    throw new Error("APP_ORIGIN 未配置，无法执行认证写请求的 Origin 校验。");
  }

  for (const origin of configuredOrigins) {
    if (new URL(origin).origin !== origin) {
      throw new Error("APP_ORIGIN 必须由逗号分隔的纯 Origin 组成，不能包含路径。");
    }
  }

  return new Set(configuredOrigins);
}
