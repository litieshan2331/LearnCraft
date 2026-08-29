/**
 * 节点知识内容生成的同源 BFF 客户端。
 *
 * 导出：
 * - createCardContentGenerationRun：创建 card_content_generate 任务。
 * - getCardContentGenerationRun：轮询节点内容任务状态。
 * - getCardContent：读取已成功的节点知识内容。
 * - ContentApiError：向展示层提供稳定的接口错误信息。
 */

export type CardContentGenerationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface CardContentGenerationRun {
  id: string;
  run_type: "card_content_generate" | string;
  status: CardContentGenerationRunStatus;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface WorkedExample {
  explanation: string;
  code: string;
  call_sequence: string[];
  expected_output: string;
}

export interface CardContent {
  id: string;
  plan_node_id: string;
  version: number;
  status: "ready";
  schema_version: "card_content.v1";
  foundation: string;
  worked_example: WorkedExample;
  pitfalls_debug: string;
  source_refs: Array<Record<string, unknown>>;
  created_at: string;
  updated_at: string;
  generated_at: string | null;
}
interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
    field_errors?: Array<{ field: string; message: string }>;
  };
}

export class ContentApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly fieldErrors: Array<{ field: string; message: string }> = [],
  ) {
    super(message);
    this.name = "ContentApiError";
  }
}

export function createCardContentGenerationRun(
  planNodeId: string,
  idempotencyKey: string,
): Promise<CardContentGenerationRun> {
  return requestJson<CardContentGenerationRun>("/api/v1/plan-nodes/" + planNodeId + "/content-runs", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({}),
  });
}

export function getCardContentGenerationRun(
  agentRunId: string,
): Promise<CardContentGenerationRun> {
  return requestJson<CardContentGenerationRun>("/api/v1/agent-runs/" + agentRunId);
}

export function getCardContent(cardContentId: string): Promise<CardContent> {
  return requestJson<CardContent>("/api/v1/card-contents/" + cardContentId);
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

async function createApiError(response: Response): Promise<ContentApiError> {
  const payload = await response.json().catch((): ApiErrorResponse => ({}));
  return new ContentApiError(
    payload.error?.code ?? "REQUEST_FAILED",
    payload.error?.message ?? "节点知识内容暂时无法读取，请稍后重试。",
    payload.error?.field_errors ?? [],
  );
}