/**
 * 模型连接设置页面的同源 BFF 客户端。
 *
 * 导出：
 * - ModelConnection：浏览器可安全读取的模型连接摘要，不包含 API Key。
 * - listModelConnections、createModelConnection、updateModelConnection、setDefaultModelConnection、deleteModelConnection：调用模型连接接口。
 * - ModelConnectionApiError：向展示层提供稳定的接口错误信息。
 */

export type ModelConnectionStatus = "active" | "invalid" | "revoked";

export interface ModelConnection {
  id: string;
  display_name: string;
  protocol: "openai_compatible";
  base_url: string;
  default_model_id: string;
  status: ModelConnectionStatus;
  is_default: boolean;
  last_verified_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateModelConnectionRequest {
  display_name: string;
  base_url: string;
  api_key: string;
  default_model_id: string;
  set_as_default: boolean;
}

export interface UpdateModelConnectionRequest {
  display_name?: string;
  base_url?: string;
  api_key?: string;
  default_model_id?: string;
}

interface ModelConnectionListResponse {
  items: ModelConnection[];
}

interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

export class ModelConnectionApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ModelConnectionApiError";
  }
}

export async function listModelConnections(): Promise<ModelConnection[]> {
  const payload = await requestJson<ModelConnectionListResponse>("/api/v1/model-connections");
  return payload.items;
}

export function createModelConnection(
  input: CreateModelConnectionRequest,
): Promise<ModelConnection> {
  return requestJson<ModelConnection>("/api/v1/model-connections", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateModelConnection(
  connectionId: string,
  input: UpdateModelConnectionRequest,
): Promise<ModelConnection> {
  return requestJson<ModelConnection>(`/api/v1/model-connections/${connectionId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function setDefaultModelConnection(connectionId: string): Promise<ModelConnection> {
  return requestJson<ModelConnection>(`/api/v1/model-connections/${connectionId}/default`, {
    method: "POST",
  });
}

export async function deleteModelConnection(connectionId: string): Promise<void> {
  const response = await fetch(`/api/v1/model-connections/${connectionId}`, {
    method: "DELETE",
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw await createApiError(response);
  }
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

async function createApiError(response: Response): Promise<ModelConnectionApiError> {
  const payload = await response.json().catch((): ApiErrorResponse => ({}));
  return new ModelConnectionApiError(
    payload.error?.code ?? "REQUEST_FAILED",
    payload.error?.message ?? "请求暂时无法完成，请稍后重试。",
  );
}
