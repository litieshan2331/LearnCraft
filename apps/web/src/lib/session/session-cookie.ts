/**
 * LearnCraft 不透明 Session Cookie 适配器。
 *
 * 导出：
 * - getSessionToken：从 Route Handler 请求中读取 HttpOnly Session Cookie。
 * - setSessionCookie：写入带有限期的安全 Cookie。
 * - clearSessionCookie：使浏览器中的 Session Cookie 立即失效。
 */

import { NextResponse } from "next/server";

const SESSION_COOKIE_NAME = "lc_session";

export function getSessionToken(request: Request): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return undefined;
  }

  const prefix = `${SESSION_COOKIE_NAME}=`;
  const sessionCookie = cookieHeader.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  return sessionCookie ? decodeURIComponent(sessionCookie.slice(prefix.length)) : undefined;
}

export function setSessionCookie(
  response: NextResponse,
  rawSessionToken: string,
  expiresAt: Date,
): void {
  const maxAge = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: rawSessionToken,
    httpOnly: true,
    secure: isSessionCookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge,
    expires: expiresAt,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: isSessionCookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
}

function isSessionCookieSecure(): boolean {
  const configuredValue = process.env.SESSION_COOKIE_SECURE?.trim();
  if (configuredValue === "true") {
    return true;
  }

  if (configuredValue === "false") {
    return false;
  }

  throw new Error("SESSION_COOKIE_SECURE 必须明确配置为 true 或 false。");
}
