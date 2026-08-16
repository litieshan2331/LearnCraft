/**
 * Assessment 题集读取应用服务单元测试。
 *
 * 测试：
 * - AssessmentQueryService.getOwnedAssessment：只返回当前用户可读取的题集。
 * - AssessmentQueryService.getOwnedAssessment：将缺失题集映射为稳定错误码。
 */

import { describe, expect, it } from "vitest";

import {
  type AssessmentQueryRepository,
  type AssessmentSnapshot,
} from "../domain/assessment-query";
import { AssessmentQueryService } from "./assessment-query-service";

const assessment: AssessmentSnapshot = {
  id: "f18621a7-4309-4a04-9769-4d602966a574",
  goalId: "04d90a58-a556-45d2-9e63-108e2a261d58",
  planId: null,
  kind: "diagnostic",
  status: "ready",
  requestedQuestionCount: 10,
  difficulty: "normal",
  items: [{
    id: "9ec8f0f8-7c6b-4c81-8dc3-2a53ac737fc3",
    ordinal: 1,
    prompt: "下列哪项最符合 TypeScript 联合类型？",
    options: [{ key: "A", text: "可以取多个候选类型之一" }],
    skillTags: ["union-types"],
    maxScore: 1,
  }],
  createdAt: new Date("2026-08-11T00:00:00.000Z"),
  updatedAt: new Date("2026-08-11T00:00:00.000Z"),
};

class FakeAssessmentQueryRepository implements AssessmentQueryRepository {
  result: AssessmentSnapshot | null = assessment;

  async findOwnedAssessment(): Promise<AssessmentSnapshot | null> {
    return this.result;
  }
}

describe("AssessmentQueryService", () => {
  it("返回当前用户拥有的题集快照", async () => {
    const service = new AssessmentQueryService(new FakeAssessmentQueryRepository());

    await expect(service.getOwnedAssessment("owner", assessment.id)).resolves.toBe(assessment);
  });

  it("将不存在或无权访问的题集映射为稳定错误码", async () => {
    const repository = new FakeAssessmentQueryRepository();
    repository.result = null;
    const service = new AssessmentQueryService(repository);

    await expect(service.getOwnedAssessment("owner", assessment.id))
      .rejects.toMatchObject({ code: "ASSESSMENT_NOT_FOUND" });
  });
});
