/**
 * Assessment 作答评分应用服务的单元测试。
 *
 * 测试：
 * - AssessmentAttemptService.submit：映射提交决策和幂等结果。
 * - AssessmentAttemptService.getOwnedAttempt：映射不可访问的作答详情。
 */

import { describe, expect, it } from "vitest";

import type {
  AssessmentAttemptRepository,
  AssessmentAttemptSnapshot,
  AssessmentAttemptSubmissionDecision,
  AssessmentAttemptSummarySnapshot,
} from "../domain/assessment-attempt";
import { AssessmentAttemptService } from "./assessment-attempt-service";

const attempt: AssessmentAttemptSnapshot = {
  id: "dd6757cd-31a1-46ca-ae7f-9f4d255368f1",
  assessmentId: "f18621a7-4309-4a04-9769-4d602966a574",
  attemptNo: 1,
  status: "graded",
  totalScore: 1,
  maxScore: 1,
  scorePercent: 100,
  masterySummary: {},
  gradingVersion: "deterministic.single_choice.v1",
  submittedAt: new Date("2026-08-18T00:00:00.000Z"),
  gradedAt: new Date("2026-08-18T00:00:00.000Z"),
  createdAt: new Date("2026-08-18T00:00:00.000Z"),
  updatedAt: new Date("2026-08-18T00:00:00.000Z"),
  items: [],
};

class FakeAssessmentAttemptRepository implements AssessmentAttemptRepository {
  submissionDecision: AssessmentAttemptSubmissionDecision = { kind: "created", attemptId: attempt.id };
  attempt: AssessmentAttemptSnapshot | null = attempt;
  summaries: AssessmentAttemptSummarySnapshot[] | null = [];

  async submitOwnedAttempt(): Promise<AssessmentAttemptSubmissionDecision> {
    return this.submissionDecision;
  }

  async findOwnedAttempt(): Promise<AssessmentAttemptSnapshot | null> {
    return this.attempt;
  }

  async findOwnedAttempts(): Promise<AssessmentAttemptSummarySnapshot[] | null> {
    return this.summaries;
  }
}

const input = {
  ownerId: "4bb1088d-0f12-4b04-b725-ff22c9fa09e2",
  assessmentId: attempt.assessmentId,
  idempotencyKey: "b9a3bbb1-0b6d-476d-9038-c50b192df519",
  requestHash: "a".repeat(64),
  answers: [{ assessmentItemId: "9ec8f0f8-7c6b-4c81-8dc3-2a53ac737fc3", selectedOptionKey: "A" }],
};

describe("AssessmentAttemptService", () => {
  it("返回新建或幂等重试得到的已评分作答", async () => {
    const repository = new FakeAssessmentAttemptRepository();
    const service = new AssessmentAttemptService(repository);

    await expect(service.submit(input)).resolves.toEqual({ attempt, created: true });

    repository.submissionDecision = { kind: "existing", attemptId: attempt.id };
    await expect(service.submit(input)).resolves.toEqual({ attempt, created: false });
  });

  it("将无效答案、重复提交和不存在详情映射为稳定错误码", async () => {
    const repository = new FakeAssessmentAttemptRepository();
    const service = new AssessmentAttemptService(repository);

    repository.submissionDecision = { kind: "invalid_answers" };
    await expect(service.submit(input)).rejects.toMatchObject({ code: "ASSESSMENT_ANSWERS_INVALID" });

    repository.submissionDecision = { kind: "already_submitted" };
    await expect(service.submit(input)).rejects.toMatchObject({ code: "ASSESSMENT_ALREADY_SUBMITTED" });

    repository.attempt = null;
    await expect(service.getOwnedAttempt(input.ownerId, attempt.id))
      .rejects.toMatchObject({ code: "ASSESSMENT_ATTEMPT_NOT_FOUND" });
  });
});
