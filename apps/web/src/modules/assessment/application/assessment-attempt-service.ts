/**
 * Assessment 作答提交、评分结果和历史查询的应用服务。
 *
 * 类：
 * - AssessmentAttemptService：协调作答仓储，并将持久化决策映射为稳定业务错误。
 */

import {
  AssessmentAttemptApplicationError,
  type AssessmentAttemptRepository,
  type AssessmentAttemptSnapshot,
  type AssessmentAttemptSubmissionInput,
  type AssessmentAttemptSummarySnapshot,
} from "../domain/assessment-attempt";

export class AssessmentAttemptService {
  constructor(private readonly repository: AssessmentAttemptRepository) {}

  async submit(
    input: AssessmentAttemptSubmissionInput,
  ): Promise<{ attempt: AssessmentAttemptSnapshot; created: boolean }> {
    const decision = await this.repository.submitOwnedAttempt(input);
    switch (decision.kind) {
      case "assessment_not_found":
        throw new AssessmentAttemptApplicationError("ASSESSMENT_NOT_FOUND");
      case "assessment_not_submittable":
        throw new AssessmentAttemptApplicationError("ASSESSMENT_NOT_SUBMITTABLE");
      case "already_submitted":
        throw new AssessmentAttemptApplicationError("ASSESSMENT_ALREADY_SUBMITTED");
      case "invalid_answers":
        throw new AssessmentAttemptApplicationError("ASSESSMENT_ANSWERS_INVALID");
      case "created":
      case "existing": {
        const attempt = await this.repository.findOwnedAttempt(input.ownerId, decision.attemptId);
        if (!attempt) {
          throw new Error("评分完成后无法读取作答记录。");
        }
        return { attempt, created: decision.kind === "created" };
      }
    }
  }

  async listOwnedAttempts(
    ownerId: string,
    assessmentId: string,
  ): Promise<AssessmentAttemptSummarySnapshot[]> {
    const attempts = await this.repository.findOwnedAttempts(ownerId, assessmentId);
    if (!attempts) {
      throw new AssessmentAttemptApplicationError("ASSESSMENT_NOT_FOUND");
    }
    return attempts;
  }

  async getOwnedAttempt(ownerId: string, attemptId: string): Promise<AssessmentAttemptSnapshot> {
    const attempt = await this.repository.findOwnedAttempt(ownerId, attemptId);
    if (!attempt) {
      throw new AssessmentAttemptApplicationError("ASSESSMENT_ATTEMPT_NOT_FOUND");
    }
    return attempt;
  }
}
