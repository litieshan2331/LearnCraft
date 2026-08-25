/**
 * Assessment 生成请求 schema 单元测试。
 *
 * 测试：
 * - assessmentGenerationRequestSchema：验证前测题量和难度边界。
 */

import { describe, expect, it } from "vitest";

import { assessmentGenerationRequestSchema } from "./assessment-generation-schemas";

describe("assessmentGenerationRequestSchema", () => {
  it("接受 10-20 题的前测并默认 normal 难度", () => {
    const parsed = assessmentGenerationRequestSchema.safeParse({
      kind: "diagnostic",
      question_count: 10,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.difficulty).toBe("normal");
    }
  });

  it("拒绝不符合题量范围的前测", () => {
    expect(assessmentGenerationRequestSchema.safeParse({
      kind: "diagnostic",
      question_count: 9,
    }).success).toBe(false);
  });
});
