/**
 * 学习助手浏览器端 API 客户端。
 *
 * 调用顺序：组件先读取或创建会话，再分页读取消息；发送消息后查询运行状态，
 * 运行完成时重新读取消息。所有请求复用当前 Session Cookie，不携带用户身份。
 */

export type LearningAssistantConversation = {
  id: string;
  goal_id: string | null;
  source_assessment_answer_id: string | null;
  status: "active" | "completed" | "archived";
  stage: string;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  active_run_id?: string | null;
};

export type LearningAssistantMessage = {
  id: string;
  conversation_id: string;
  sequence_no: number;
  turn_no: number;
  role: "user" | "assistant" | "tool";
  content: string | null;
  created_at: string;
};

export type LearningAssistantRun = {
  id: string;
  conversation_id: string;
  trigger_message_id: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  orchestration_version: string;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  model_call_count: number;
  tool_call_count: number;
  error_code: string | null;
  error_summary: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LearningAssistantMessagePage = {
  items: LearningAssistantMessage[];
  next_after_sequence_no: number | null;
};

export type SendLearningAssistantMessageResult = {
  message: LearningAssistantMessage;
  run: LearningAssistantRun;
  created: boolean;
};

type ApiErrorPayload = {
  error?: {
    code?: string;
    message?: string;
  };
};

/** 将学习助手 HTTP 错误转换为展示层可识别的异常。 */
export class LearningAssistantApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "LearningAssistantApiError";
  }
}

/** 读取当前用户最近使用的学习助手会话。 */
export async function listLearningAssistantConversations(limit = 1): Promise<LearningAssistantConversation[]> {
  const payload = await requestJson<{ items: LearningAssistantConversation[] }>(
    `/api/v1/learning-assistant/conversations?limit=${limit}`,
  );
  return payload.items;
}

/** 创建一个不绑定目标的学习助手会话。 */
export function createLearningAssistantConversation(): Promise<LearningAssistantConversation> {
  return requestJson<LearningAssistantConversation>("/api/v1/learning-assistant/conversations", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** 读取会话详情和刷新后需要恢复的在途运行。 */
export function getLearningAssistantConversation(conversationId: string): Promise<LearningAssistantConversation> {
  return requestJson<LearningAssistantConversation>(
    `/api/v1/learning-assistant/conversations/${conversationId}`,
  );
}

/** 按消息序号读取一页完整历史。 */
export function listLearningAssistantMessages(
  conversationId: string,
  afterSequenceNo = 0,
): Promise<LearningAssistantMessagePage> {
  return requestJson<LearningAssistantMessagePage>(
    `/api/v1/learning-assistant/conversations/${conversationId}/messages?after_sequence_no=${afterSequenceNo}&limit=100`,
  );
}

/** 发送用户消息并创建或复用一次对话运行；重试时必须复用调用方持有的幂等键。 */
export function sendLearningAssistantMessage(
  conversationId: string,
  content: string,
  idempotencyKey: string,
): Promise<SendLearningAssistantMessageResult> {
  return requestJson<SendLearningAssistantMessageResult>(
    `/api/v1/learning-assistant/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ content }),
    },
  );
}

/** 查询一次对话运行的安全状态。 */
export function getLearningAssistantRun(runId: string): Promise<LearningAssistantRun> {
  return requestJson<LearningAssistantRun>(`/api/v1/learning-assistant/runs/${runId}`);
}

/** 调用同源 API 并解析 JSON；写请求自动发送当前浏览器的 Cookie。 */
async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw await createApiError(response);
  }

  return response.json() as Promise<T>;
}

/** 从统一错误响应中提取安全错误码和文案。 */
async function createApiError(response: Response): Promise<LearningAssistantApiError> {
  const payload = await response.json().catch((): ApiErrorPayload => ({}));
  return new LearningAssistantApiError(
    payload.error?.code ?? "REQUEST_FAILED",
    payload.error?.message ?? "学习助手暂时无法响应，请稍后重试。",
  );
}
