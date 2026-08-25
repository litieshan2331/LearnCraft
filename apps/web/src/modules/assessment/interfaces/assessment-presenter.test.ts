/**
 * Assessment 公开响应映射器单元测试。
 *
 * 测试：
 * - presentAssessment：仅输出用户作答所需字段，不能泄露答案或解析。
 */

import { describe, expect, it } from "vitest";

import type { AssessmentSnapshot } from "../domain/assessment-query";
import { presentAssessment } from "./assessment-presenter";

const assessment: AssessmentSnapshot = {
  id: "f18621a7-4309-4a04-9769-4d602966a574",
  goalId: "04d90a58-a556-45d2-9e63-108e2a261d58",
  planId: null,
  planNodeId: null,
  sourceCardContentId: null,
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

describe("presentAssessment", () => {
  it("不返回 answer_key、解析或评分内部字段", () => {
    const response = presentAssessment(assessment);

    expect(response.items[0]).toEqual({
      id: "9ec8f0f8-7c6b-4c81-8dc3-2a53ac737fc3",
      ordinal: 1,
      prompt: "下列哪项最符合 TypeScript 联合类型？",
      options: [{ key: "A", text: "可以取多个候选类型之一" }],
      skill_tags: ["union-types"],
      max_score: 1,
    });
    expect(response.items[0]).not.toHaveProperty("answer_key");
    expect(response.items[0]).not.toHaveProperty("explanation");
  });
});
