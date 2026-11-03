/**
 * Human-in-the-Loop 合同测试。
 * 调用顺序：构造问题批次 → 验证问题/选项边界 → 验证答案合同与序列化数据形状。
 */

import { describe, expect, it } from "vitest";

import {
  HumanReviewAnswerSchema,
  HumanReviewQuestionBatchSchema,
} from "./human-review";

function validBatch() {
  return {
    schema_version: "plan_generation_human_review.v1" as const,
    review_id: "11111111-1111-4111-8111-111111111111",
    questions: [{
      question_id: "pace",
      prompt: "你希望每周投入多少时间？",
      options: [
        { option_id: "steady", label: "稳定推进", kind: "preset" as const, input: null },
        { option_id: "intensive", label: "集中强化", kind: "preset" as const, input: null },
        { option_id: "custom", label: "自定义", kind: "custom_text" as const, input: { min_length: 1, max_length: 500 } },
      ],
    }],
  };
}

describe("HumanReviewQuestionBatchSchema", () => {
  it("接受 1 个问题和固定三个选项", () => {
    expect(HumanReviewQuestionBatchSchema.parse(validBatch()).questions).toHaveLength(1);
  });

  it("拒绝不是三个选项或第三项不是自定义输入", () => {
    const value = validBatch();
    value.questions[0].options = value.questions[0].options.slice(0, 2);
    expect(() => HumanReviewQuestionBatchSchema.parse(value)).toThrow();

    const wrongOrder = validBatch();
    wrongOrder.questions[0].options[2] = { ...wrongOrder.questions[0].options[0] };
    expect(() => HumanReviewQuestionBatchSchema.parse(wrongOrder)).toThrow();
  });

  it("拒绝重复问题 ID 和重复选项 ID", () => {
    const value = validBatch();
    value.questions.push({ ...value.questions[0], question_id: "pace" });
    expect(() => HumanReviewQuestionBatchSchema.parse(value)).toThrow();

    const duplicateOption = validBatch();
    duplicateOption.questions[0].options[1].option_id = "steady";
    expect(() => HumanReviewQuestionBatchSchema.parse(duplicateOption)).toThrow();
  });
});

describe("HumanReviewAnswerSchema", () => {
  it("只接受可序列化的结构化答案", () => {
    expect(HumanReviewAnswerSchema.parse({
      question_id: "pace",
      option_id: "custom",
      custom_text: "希望多安排项目练习",
    })).toEqual({
      question_id: "pace",
      option_id: "custom",
      custom_text: "希望多安排项目练习",
    });
  });

  it("拒绝未知字段和超长自定义文本", () => {
    expect(() => HumanReviewAnswerSchema.parse({
      question_id: "pace",
      option_id: "custom",
      custom_text: "x".repeat(4_001),
    })).toThrow();
    expect(() => HumanReviewAnswerSchema.parse({
      question_id: "pace",
      option_id: "steady",
      thread_id: "client-controlled",
    })).toThrow();
  });
});
