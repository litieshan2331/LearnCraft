/**
 * Assessment 作答提交请求 schema 的单元测试。
 *
 * 测试：
 * - assessmentAttemptSubmissionRequestSchema：要求每题只提交一个合法选项。
 */

import { describe, expect, it } from "vitest";

import { assessmentAttemptSubmissionRequestSchema } from "./assessment-attempt-schemas";

describe("assessmentAttemptSubmissionRequestSchema", () => {
  it("接受 UUID 题目 ID 与 A-F 选项，拒绝重复题目和非法选项", () => {
    const itemId = "9ec8f0f8-7c6b-4c81-8dc3-2a53ac737fc3";
    expect(assessmentAttemptSubmissionRequestSchema.safeParse({
      answers: [{ assessment_item_id: itemId, selected_option_key: "A" }],
    }).success).toBe(true);
    expect(assessmentAttemptSubmissionRequestSchema.safeParse({
      answers: [
        { assessment_item_id: itemId, selected_option_key: "A" },
        { assessment_item_id: itemId, selected_option_key: "B" },
      ],
    }).success).toBe(false);
    expect(assessmentAttemptSubmissionRequestSchema.safeParse({
      answers: [{ assessment_item_id: itemId, selected_option_key: "Z" }],
    }).success).toBe(false);
  });
});
