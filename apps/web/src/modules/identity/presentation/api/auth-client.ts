/**
 * Identity 前端调用 BFF 认证接口的客户端。
 *
 * 导出：
 * - register、login、logout、getCurrentUser：调用同域 /api/v1/auth 接口。
 * - AuthenticationApiError：向表单暴露稳定错误码、中文消息与字段错误。
 */

export interface RegisterRequest {
  email: string;
  display_name: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  display_name: string;
}

export interface CurrentUser extends AuthenticatedUser {
  profile_completed: boolean;
}

interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
    field_errors?: Array<{ field: string; message: string }>;
  };
}

export class AuthenticationApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly fieldErrors: Array<{ field: string; message: string }> = [],
  ) {
    super(message);
    this.name = "AuthenticationApiError";
  }
}

export function register(input: RegisterRequest): Promise<AuthenticatedUser> {
  return requestJson<AuthenticatedUser>("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function login(input: LoginRequest): Promise<AuthenticatedUser> {
  return requestJson<AuthenticatedUser>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function logout(): Promise<void> {
  const response = await fetch("/api/v1/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw await createApiError(response);
  }
}

export function getCurrentUser(): Promise<CurrentUser> {
  return requestJson<CurrentUser>("/api/v1/auth/me");
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw await createApiError(response);
  }

  return response.json() as Promise<T>;
}

async function createApiError(response: Response): Promise<AuthenticationApiError> {
  const payload = await response.json().catch((): ApiErrorResponse => ({}));
  const error = payload.error;

  return new AuthenticationApiError(
    error?.code ?? "REQUEST_FAILED",
    error?.message ?? "请求暂时无法完成，请稍后重试。",
    error?.field_errors ?? [],
  );
}
