/**
 * Assessment 作答、确定性评分与历史查询的领域契约。
 *
 * 类型与接口：
 * - AssessmentAttemptSubmissionInput：用户提交完整单选答案的输入。
 * - AssessmentAttemptSnapshot、AssessmentAttemptSummarySnapshot：评分详情与历史摘要。
 * - AssessmentAttemptRepository：作答写入和所有者范围查询的持久化端口。
 * - AssessmentAttemptApplicationError：作答用例的稳定业务错误。
 */

import type { AssessmentOptionSnapshot } from "./assessment-query";

export interface SelectedAssessmentAnswer {
  assessmentItemId: string;
  selectedOptionKey: string;
}

export interface AssessmentAttemptSubmissionInput {
  ownerId: string;
  assessmentId: string;
  idempotencyKey: string;
  requestHash: string;
  answers: SelectedAssessmentAnswer[];
}

export interface AssessmentAttemptItemSnapshot {
  assessmentItemId: string;
  ordinal: number;
  prompt: string;
  options: AssessmentOptionSnapshot[];
  skillTags: string[];
  maxScore: number;
  selectedOptionKey: string;
  correctOptionKey: string;
  isCorrect: boolean;
  score: number;
  explanation: string;
  weaknessTags: string[];
}

export interface AssessmentAttemptSnapshot {
  id: string;
  assessmentId: string;
  attemptNo: number;
  status: "graded";
  totalScore: number;
  maxScore: number;
  scorePercent: number;
  masterySummary: Record<string, unknown>;
  gradingVersion: string;
  submittedAt: Date;
  gradedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  items: AssessmentAttemptItemSnapshot[];
}

export interface AssessmentAttemptSummarySnapshot {
  id: string;
  assessmentId: string;
  attemptNo: number;
  status: "graded";
  scorePercent: number;
  wrongCount: number;
  submittedAt: Date;
  gradedAt: Date;
}

export type AssessmentAttemptSubmissionDecision =
  | { kind: "created"; attemptId: string }
  | { kind: "existing"; attemptId: string }
  | { kind: "assessment_not_found" }
  | { kind: "assessment_not_submittable" }
  | { kind: "already_submitted" }
  | { kind: "invalid_answers" };

export interface AssessmentAttemptRepository {
  submitOwnedAttempt(input: AssessmentAttemptSubmissionInput): Promise<AssessmentAttemptSubmissionDecision>;
  findOwnedAttempt(ownerId: string, attemptId: string): Promise<AssessmentAttemptSnapshot | null>;
  findOwnedAttempts(
    ownerId: string,
    assessmentId: string,
  ): Promise<AssessmentAttemptSummarySnapshot[] | null>;
}

export type AssessmentAttemptApplicationErrorCode =
  | "ASSESSMENT_NOT_FOUND"
  | "ASSESSMENT_NOT_SUBMITTABLE"
  | "ASSESSMENT_ALREADY_SUBMITTED"
  | "ASSESSMENT_ANSWERS_INVALID"
  | "ASSESSMENT_ATTEMPT_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT";

export class AssessmentAttemptApplicationError extends Error {
  constructor(public readonly code: AssessmentAttemptApplicationErrorCode) {
    super(code);
  }
}
