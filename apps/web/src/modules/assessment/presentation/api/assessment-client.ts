/**
 * 前测题集的同源 BFF 客户端。
 *
 * 导出：
 * - createAssessmentRun、getAgentRun、cancelAgentRun：创建、轮询和协作式取消前测生成任务。
 * - getAssessment、getPosttestAssessments：读取题集及章节已有后测摘要。
 * - submitAssessmentAttempt、getAssessmentAttempts、getAssessmentAttempt：提交作答并读取评分结果与历史摘要。
 * - AssessmentApiError：向展示层提供稳定的接口错误信息。
 */

export type AssessmentKind = "diagnostic" | "post_test";
export type AssessmentDifficulty = "normal" | "hard";
export type AgentRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";

export interface AssessmentGenerationRequest {
  kind: "diagnostic";
  question_count: number;
  difficulty: AssessmentDifficulty;
}

export interface PosttestGenerationRequest {
  question_count: number;
  difficulty: AssessmentDifficulty;
}
export interface PosttestAssessmentSummary {
  assessment_id: string;
  plan_node_id: string;
  source_card_content_id: string;
  kind: "post_test";
  status: string;
  question_count: number;
  difficulty: AssessmentDifficulty;
  created_at: string;
  updated_at: string;
  latest_attempt: {
    id: string;
    assessment_id: string;
    attempt_no: number;
    status: "graded";
    score_percent: number;
    wrong_count: number;
    submitted_at: string;
    graded_at: string;
  } | null;
}
export interface AgentRun {
  id: string;
  run_type: string;
  status: AgentRunStatus;
  target_type: string;
  target_id: string;
  model_connection_id: string | null;
  requested_model_id: string | null;
  retry_count: number;
  trace_id: string;
  started_at?: string;
  finished_at?: string;
  assessment_result?: {
    assessment_id: string;
    question_count: number;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  created_at: string;
  updated_at: string;
}

export interface AssessmentOption {
  key: string;
  text: string;
}

export interface AssessmentItem {
  id: string;
  ordinal: number;
  prompt: string;
  options: AssessmentOption[];
  skill_tags: string[];
  max_score: number;
}

export interface Assessment {
  id: string;
  goal_id: string;
  plan_id: string | null;
  plan_node_id: string | null;
  source_card_content_id: string | null;
  kind: AssessmentKind | "card_quiz";
  status: string;
  question_count: number;
  difficulty: AssessmentDifficulty;
  items: AssessmentItem[];
  created_at: string;
  updated_at: string;
}

export interface AssessmentAttemptSubmissionRequest {
  answers: Array<{
    assessment_item_id: string;
    selected_option_key: string;
  }>;
}

export interface AssessmentAttemptSummary {
  id: string;
  assessment_id: string;
  attempt_no: number;
  status: "graded";
  score_percent: number;
  wrong_count: number;
  submitted_at: string;
  graded_at: string;
}

export interface AssessmentAttemptItem extends AssessmentItem {
  assessment_item_id: string;
  selected_option_key: string;
  correct_option_key: string;
  is_correct: boolean;
  score: number;
  explanation: string;
  weakness_tags: string[];
}

export interface AssessmentAttempt {
  id: string;
  assessment_id: string;
  attempt_no: number;
  status: "graded";
  score: {
    total_score: number;
    max_score: number;
    score_percent: number;
  };
  mastery_summary: Record<string, unknown>;
  grading_version: string;
  submitted_at: string;
  graded_at: string;
  created_at: string;
  updated_at: string;
  items: AssessmentAttemptItem[];
}

interface AssessmentAttemptListResponse {
  items: AssessmentAttemptSummary[];
}

interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
    field_errors?: Array<{ field: string; message: string }>;
  };
}

export class AssessmentApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly fieldErrors: Array<{ field: string; message: string }> = [],
  ) {
    super(message);
    this.name = "AssessmentApiError";
  }
}

export function createAssessmentRun(
  goalId: string,
  input: AssessmentGenerationRequest,
  idempotencyKey: string,
): Promise<AgentRun> {
  return requestJson<AgentRun>(`/api/v1/learning-goals/${goalId}/assessment-runs`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function createPosttestRun(
  planNodeId: string,
  input: PosttestGenerationRequest,
  idempotencyKey: string,
): Promise<AgentRun> {
  return requestJson<AgentRun>("/api/v1/plan-nodes/" + planNodeId + "/post-assessment-runs", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}
export function getAgentRun(agentRunId: string): Promise<AgentRun> {
  return requestJson<AgentRun>(`/api/v1/agent-runs/${agentRunId}`);
}

export function cancelAgentRun(agentRunId: string): Promise<AgentRun> {
  return requestJson<AgentRun>(`/api/v1/agent-runs/${agentRunId}/cancel`, {
    method: "POST",
  });
}

export async function getPosttestAssessments(planNodeId: string): Promise<PosttestAssessmentSummary[]> {
  const payload = await requestJson<{ items: PosttestAssessmentSummary[] }>(
    `/api/v1/plan-nodes/${planNodeId}/post-assessments`,
  );
  return payload.items;
}
export function getAssessment(assessmentId: string): Promise<Assessment> {
  return requestJson<Assessment>(`/api/v1/assessments/${assessmentId}`);
}

export function submitAssessmentAttempt(
  assessmentId: string,
  input: AssessmentAttemptSubmissionRequest,
  idempotencyKey: string,
): Promise<AssessmentAttempt> {
  return requestJson<AssessmentAttempt>(`/api/v1/assessments/${assessmentId}/attempts`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function getAssessmentAttempts(assessmentId: string): Promise<AssessmentAttemptSummary[]> {
  const payload = await requestJson<AssessmentAttemptListResponse>(`/api/v1/assessments/${assessmentId}/attempts`);
  return payload.items;
}

export function getAssessmentAttempt(attemptId: string): Promise<AssessmentAttempt> {
  return requestJson<AssessmentAttempt>(`/api/v1/assessment-attempts/${attemptId}`);
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

async function createApiError(response: Response): Promise<AssessmentApiError> {
  const payload = await response.json().catch((): ApiErrorResponse => ({}));
  return new AssessmentApiError(
    payload.error?.code ?? "REQUEST_FAILED",
    payload.error?.message ?? "请求暂时无法完成，请稍后重试。",
    payload.error?.field_errors ?? [],
  );
}
