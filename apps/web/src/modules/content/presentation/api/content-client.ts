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

/**
 * 示例文件（v2）：一个文件一个元素；role 默认 module，language 为受控白名单标识。
 * `html` 是读取接口在服务端预渲染的、已转义的内联高亮 HTML，浏览器不再加载高亮引擎。
 */
export interface WorkedExampleFile {
  path: string;
  language: string;
  role: string;
  content: string;
  html: string;
}

/** 调用顺序（v2）：对象化，指明「哪个文件里的哪个函数」。 */
export interface WorkedExampleCallStep {
  step: number;
  file: string;
  function: string;
  note: string;
}

/**
 * 示例区块：v2 为 files + entry_file + 对象化 call_sequence；
 * 历史 v1 内容由服务端读侧归一化成同一形状（expected_output 始终是字符串）。
 */
export interface WorkedExample {
  explanation: string;
  files: WorkedExampleFile[];
  entry_file: string;
  call_sequence: WorkedExampleCallStep[];
  expected_output: string;
}

export interface PitfallDebug {
  title: string;
  cause: string;
  fix: string;
}

export interface CardContent {
  id: string;
  plan_node_id: string;
  version: number;
  status: "ready";
  schema_version: "card_content.v1" | "card_content.v2";
  foundation: string;
  worked_example: WorkedExample;
  pitfalls_debug: PitfallDebug[];
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