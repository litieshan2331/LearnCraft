/**
 * Assessment 题集读取的领域模型与持久化端口。
 *
 * 导出：
 * - AssessmentSnapshot、AssessmentItemSnapshot：不含答案的公开题集快照。
 * - PosttestAssessmentSummary：节点后测列表及最近作答摘要。
 * - AssessmentQueryRepository：按所有者读取题集及节点后测列表的持久化端口。
 * - AssessmentQueryApplicationError：映射稳定的题集读取错误码。
 */

export const ASSESSMENT_KINDS = ["diagnostic", "post_test", "card_quiz"] as const;
export const ASSESSMENT_STATUSES = [
  "generating",
  "ready",
  "in_progress",
  "submitted",
  "grading",
  "graded",
  "failed",
  "archived",
] as const;

export type AssessmentKind = (typeof ASSESSMENT_KINDS)[number];
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

export interface AssessmentOptionSnapshot {
  key: string;
  text: string;
}

export interface AssessmentItemSnapshot {
  id: string;
  ordinal: number;
  prompt: string;
  options: AssessmentOptionSnapshot[];
  skillTags: string[];
  maxScore: number;
}

export interface AssessmentSnapshot {
  id: string;
  goalId: string;
  planId: string | null;
  planNodeId: string | null;
  sourceCardContentId: string | null;
  kind: AssessmentKind;
  status: AssessmentStatus;
  requestedQuestionCount: number | null;
  difficulty: "normal" | "hard";
  items: AssessmentItemSnapshot[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PosttestAssessmentAttemptSummary {
  id: string;
  assessmentId: string;
  attemptNo: number;
  status: "graded";
  scorePercent: number;
  wrongCount: number;
  submittedAt: Date;
  gradedAt: Date;
}

export interface PosttestAssessmentSummary {
  posttestNo: number;
  assessmentId: string;
  planNodeId: string;
  sourceCardContentId: string;
  status: AssessmentStatus;
  questionCount: number;
  difficulty: "normal" | "hard";
  createdAt: Date;
  updatedAt: Date;
  latestAttempt: PosttestAssessmentAttemptSummary | null;
}

export interface PosttestAssessmentAttemptRecord extends PosttestAssessmentAttemptSummary {
  posttestNo: number;
  planNodeId: string;
  sourceCardContentId: string;
}

export interface AssessmentQueryRepository {
  findOwnedAssessment(ownerId: string, assessmentId: string): Promise<AssessmentSnapshot | null>;
  findOwnedPosttestsByNode(ownerId: string, planNodeId: string): Promise<PosttestAssessmentSummary[]>;
}

export type AssessmentQueryApplicationErrorCode = "ASSESSMENT_NOT_FOUND";

export class AssessmentQueryApplicationError extends Error {
  constructor(public readonly code: AssessmentQueryApplicationErrorCode) {
    super(code);
    this.name = "AssessmentQueryApplicationError";
  }
}

export function isAssessmentKind(value: string): value is AssessmentKind {
  return (ASSESSMENT_KINDS as readonly string[]).includes(value);
}

export function isAssessmentStatus(value: string): value is AssessmentStatus {
  return (ASSESSMENT_STATUSES as readonly string[]).includes(value);
}
