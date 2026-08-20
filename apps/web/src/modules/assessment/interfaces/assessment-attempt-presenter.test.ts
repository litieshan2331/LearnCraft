/**
 * Assessment 作答评分响应映射器的单元测试。
 *
 * 测试：
 * - presentAssessmentAttempt：仅供提交成功或详情读取时返回正确答案和解析。
 */

import { describe, expect, it } from "vitest";

import type { AssessmentAttemptSnapshot } from "../domain/assessment-attempt";
import { presentAssessmentAttempt } from "./assessment-attempt-presenter";

const attempt: AssessmentAttemptSnapshot = {
  id: "dd6757cd-31a1-46ca-ae7f-9f4d255368f1",
  assessmentId: "f18621a7-4309-4a04-9769-4d602966a574",
  attemptNo: 1,
  status: "graded",
  totalScore: 0,
  maxScore: 1,
  scorePercent: 0,
  masterySummary: {},
  gradingVersion: "deterministic.single_choice.v1",
  submittedAt: new Date("2026-08-20T00:00:00.000Z"),
  gradedAt: new Date("2026-08-20T00:00:00.000Z"),
  createdAt: new Date("2026-08-20T00:00:00.000Z"),
  updatedAt: new Date("2026-08-20T00:00:00.000Z"),
  items: [{
    assessmentItemId: "9ec8f0f8-7c6b-4c81-8dc3-2a53ac737fc3",
    ordinal: 1,
    prompt: "泛型约束的作用是什么？",
    options: [{ key: "A", text: "限制可用类型" }, { key: "B", text: "删除类型" }],
    skillTags: ["generics"],
    maxScore: 1,
    selectedOptionKey: "B",
    correctOptionKey: "A",
    isCorrect: false,
    score: 0,
    explanation: "约束用于限制类型参数。",
    weaknessTags: ["generics"],
  }],
};

describe("presentAssessmentAttempt", () => {
  it("返回提交后的选择答案、正确答案、解析和得分", () => {
    const response = presentAssessmentAttempt(attempt);

    expect(response.score.score_percent).toBe(0);
    expect(response.items[0]).toMatchObject({
      selected_option_key: "B",
      correct_option_key: "A",
      is_correct: false,
      explanation: "约束用于限制类型参数。",
    });
  });
});
