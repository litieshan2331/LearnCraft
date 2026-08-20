/**
 * 学习画像与学习目标的同源 BFF 客户端。
 *
 * 导出：
 * - getLearnerProfile、saveLearnerProfile：读取和保存当前用户画像。
 * - createLearningGoal、getLearningGoal、getLearningGoals：创建和读取当前用户的学习目标。
 * - deleteLearningGoal：删除没有进行中任务的学习目标。
 * - ProfileApiError：向展示层提供稳定的接口错误信息。
 */

export type CurrentLevel = "beginner" | "intermediate" | "advanced";
export type ContentPreference = "document_first" | "video_first" | "balanced";
export type OperatingSystem = "windows" | "macos" | "linux" | "other";
export type LearningGoalStatus =
  | "draft"
  | "assessment_pending"
  | "assessment_in_progress"
  | "planning"
  | "active"
  | "completed"
  | "archived"
  | "failed";

export interface LearnerProfile {
  current_level: CurrentLevel;
  primary_language: "zh-CN";
  weekly_minutes: number;
  operating_system: OperatingSystem | null;
  background_summary: string | null;
  content_preference: ContentPreference;
  profile_version: number;
  created_at: string;
  updated_at: string;
}

export interface LearnerProfileUpsertRequest {
  current_level: CurrentLevel;
  weekly_minutes: number;
  operating_system: OperatingSystem;
  background_summary: string | null;
  content_preference: ContentPreference;
}

export interface LearningGoal {
  id: string;
  topic: string;
  title: string;
  description: string;
  desired_outcome: string;
  target_date: string | null;
  weekly_minutes_override: number | null;
  model_connection_id: string | null;
  profile_version: number;
  status: LearningGoalStatus;
  created_at: string;
  updated_at: string;
}

export type LatestAssessmentStatus =
  | "generating"
  | "ready"
  | "in_progress"
  | "submitted"
  | "grading"
  | "graded"
  | "failed"
  | "archived";

export interface LatestAssessmentSummary {
  id: string;
  status: LatestAssessmentStatus;
  question_count: number | null;
  difficulty: "normal" | "hard";
  score_percent: number | null;
  created_at: string;
  updated_at: string;
}

export interface LearningGoalListItem extends LearningGoal {
  latest_assessment: LatestAssessmentSummary | null;
}

export interface LearningGoalCreateRequest {
  topic: string;
  title: string;
  description: string;
  desired_outcome: string;
  target_date: string | null;
  weekly_minutes_override: number | null;
  model_connection_id: string | null;
}

interface LearnerProfileResponse {
  profile: LearnerProfile | null;
}

interface LearningGoalListResponse {
  items: LearningGoalListItem[];
}

interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
    field_errors?: Array<{ field: string; message: string }>;
  };
}

export class ProfileApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly fieldErrors: Array<{ field: string; message: string }> = [],
  ) {
    super(message);
    this.name = "ProfileApiError";
  }
}

export async function getLearnerProfile(): Promise<LearnerProfile | null> {
  const payload = await requestJson<LearnerProfileResponse>("/api/v1/learner-profile");
  return payload.profile;
}

export function saveLearnerProfile(input: LearnerProfileUpsertRequest): Promise<LearnerProfile> {
  return requestJson<LearnerProfile>("/api/v1/learner-profile", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function createLearningGoal(
  input: LearningGoalCreateRequest,
  idempotencyKey: string,
): Promise<LearningGoal> {
  return requestJson<LearningGoal>("/api/v1/learning-goals", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function getLearningGoal(goalId: string): Promise<LearningGoal> {
  return requestJson<LearningGoal>(`/api/v1/learning-goals/${goalId}`);
}

export async function getLearningGoals(): Promise<LearningGoalListItem[]> {
  const payload = await requestJson<LearningGoalListResponse>("/api/v1/learning-goals");
  return payload.items;
}

export function deleteLearningGoal(goalId: string): Promise<void> {
  return requestJson<void>(`/api/v1/learning-goals/${goalId}`, {
    method: "DELETE",
  });
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

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function createApiError(response: Response): Promise<ProfileApiError> {
  const payload = await response.json().catch((): ApiErrorResponse => ({}));
  return new ProfileApiError(
    payload.error?.code ?? "REQUEST_FAILED",
    payload.error?.message ?? "请求暂时无法完成，请稍后重试。",
    payload.error?.field_errors ?? [],
  );
}
