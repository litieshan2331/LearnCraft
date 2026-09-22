/**
 * Profile 限界上下文的领域模型与持久化端口。
 *
 * 导出：
 * - LearnerProfileSnapshot、LearningGoalSnapshot：供应用层与接口层使用的安全业务快照。
 * - ProfileRepository：画像、学习目标和目标级模型连接归属的持久化端口。
 * - ProfileApplicationError：画像与目标用例的稳定业务错误。
 */

export const CURRENT_LEVELS = ["beginner", "intermediate", "advanced"] as const;
export const CONTENT_PREFERENCES = ["document_first", "video_first", "balanced"] as const;
export const LEARNING_GOAL_STATUSES = [
  "draft",
  "assessment_pending",
  "assessment_in_progress",
  "planning",
  "active",
  "completed",
  "archived",
  "failed",
] as const;

export type CurrentLevel = (typeof CURRENT_LEVELS)[number];
export type ContentPreference = (typeof CONTENT_PREFERENCES)[number];
export type LearningGoalStatus = (typeof LEARNING_GOAL_STATUSES)[number];

export const DIAGNOSTIC_ASSESSMENT_STATUSES = [
  "generating",
  "ready",
  "in_progress",
  "submitted",
  "grading",
  "graded",
  "failed",
  "archived",
] as const;

export type DiagnosticAssessmentStatus = (typeof DIAGNOSTIC_ASSESSMENT_STATUSES)[number];

export interface LearnerProfileSnapshot {
  userId: string;
  currentLevel: CurrentLevel;
  primaryLanguage: string;
  weeklyMinutes: number;
  operatingSystem: string | null;
  backgroundSummary: string | null;
  contentPreference: ContentPreference;
  profileVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LearningGoalSnapshot {
  id: string;
  ownerId: string;
  topic: string;
  title: string;
  description: string;
  desiredOutcome: string;
  targetDate: string | null;
  weeklyMinutesOverride: number | null;
  modelConnectionId: string | null;
  profileVersion: number;
  status: LearningGoalStatus;
  activeLearningPlanId: string | null;
  /** 该目标正在执行的 plan_generate 任务 id（queued/running）；用于刷新后继续展示进度。 */
  latestPlanRunId: string | null;
  /** 该目标正在执行的 assessment_generate 任务 id（queued/running）；用于刷新后继续展示进度。 */
  latestAssessmentRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LatestDiagnosticAssessmentSnapshot {
  id: string;
  status: DiagnosticAssessmentStatus;
  questionCount: number | null;
  difficulty: "normal" | "hard";
  scorePercent: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LearningGoalListItemSnapshot extends LearningGoalSnapshot {
  latestDiagnosticAssessment: LatestDiagnosticAssessmentSnapshot | null;
}

export interface SaveLearnerProfileInput {
  ownerId: string;
  currentLevel: CurrentLevel;
  weeklyMinutes: number;
  operatingSystem: string | null;
  backgroundSummary: string | null;
  contentPreference: ContentPreference;
}

export interface CreateLearningGoalInput {
  ownerId: string;
  topic: string;
  title: string;
  description: string;
  desiredOutcome: string;
  targetDate: string | null;
  weeklyMinutesOverride: number | null;
  modelConnectionId: string | null;
  idempotencyKey: string;
  requestHash: string;
}

export interface CreateLearningGoalResult {
  goal: LearningGoalSnapshot;
  created: boolean;
}

export type LearningGoalDeletionDecision = "deleted" | "not_found" | "has_active_runs";

export interface ProfileRepository {
  findProfile(ownerId: string): Promise<LearnerProfileSnapshot | null>;
  saveProfile(input: SaveLearnerProfileInput): Promise<LearnerProfileSnapshot>;
  isActiveModelConnectionOwned(ownerId: string, modelConnectionId: string): Promise<boolean>;
  createGoal(input: CreateLearningGoalInput & { profileVersion: number }): Promise<CreateLearningGoalResult>;
  findOwnedGoal(ownerId: string, goalId: string): Promise<LearningGoalSnapshot | null>;
  findOwnedGoals(ownerId: string): Promise<LearningGoalListItemSnapshot[]>;
  deleteOwnedGoal(ownerId: string, goalId: string): Promise<LearningGoalDeletionDecision>;
}

export type ProfileApplicationErrorCode =
  | "PROFILE_REQUIRED"
  | "MODEL_CONNECTION_NOT_FOUND"
  | "LEARNING_GOAL_NOT_FOUND"
  | "GOAL_HAS_ACTIVE_RUNS"
  | "IDEMPOTENCY_CONFLICT";

export class ProfileApplicationError extends Error {
  constructor(public readonly code: ProfileApplicationErrorCode) {
    super(code);
    this.name = "ProfileApplicationError";
  }
}

export function isCurrentLevel(value: string): value is CurrentLevel {
  return (CURRENT_LEVELS as readonly string[]).includes(value);
}

export function isContentPreference(value: string): value is ContentPreference {
  return (CONTENT_PREFERENCES as readonly string[]).includes(value);
}

export function isLearningGoalStatus(value: string): value is LearningGoalStatus {
  return (LEARNING_GOAL_STATUSES as readonly string[]).includes(value);
}

export function isDiagnosticAssessmentStatus(value: string): value is DiagnosticAssessmentStatus {
  return (DIAGNOSTIC_ASSESSMENT_STATUSES as readonly string[]).includes(value);
}
