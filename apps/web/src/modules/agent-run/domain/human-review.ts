/**
 * AgentRun Human-in-the-Loop 的结构化合同与领域类型。
 * 调用顺序：问题/答案 schema 校验 → Repository 持久化与读取 → API Presenter 输出安全快照。
 */

import { z } from "zod";

export const HumanReviewOptionSchema = z.object({
  option_id: z.string().min(1).max(100),
  label: z.string().min(1).max(500),
  kind: z.enum(["preset", "custom_text"]),
  input: z.object({
    min_length: z.number().int().min(0).max(2_000),
    max_length: z.number().int().min(1).max(4_000),
  }).nullable(),
}).strict().superRefine((value, context) => {
  if (value.kind === "custom_text" && value.input === null) {
    context.addIssue({ code: "custom", path: ["input"], message: "自定义选项必须声明输入边界。" });
  }
  if (value.kind === "preset" && value.input !== null) {
    context.addIssue({ code: "custom", path: ["input"], message: "预设选项不能声明自定义输入。" });
  }
});

export const HumanReviewQuestionSchema = z.object({
  question_id: z.string().min(1).max(100),
  prompt: z.string().min(1).max(2_000),
  options: z.array(HumanReviewOptionSchema).length(3),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.options.forEach((option, index) => {
    if (ids.has(option.option_id)) {
      context.addIssue({ code: "custom", path: ["options", index, "option_id"], message: "选项 ID 必须唯一。" });
    }
    ids.add(option.option_id);
  });
  if (value.options[2]?.kind !== "custom_text") {
    context.addIssue({ code: "custom", path: ["options", 2, "kind"], message: "第三个选项必须支持自定义文本。" });
  }
});

export const HumanReviewQuestionBatchSchema = z.object({
  schema_version: z.literal("plan_generation_human_review.v1"),
  review_id: z.uuid(),
  questions: z.array(HumanReviewQuestionSchema).min(1).max(3),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.questions.forEach((question, index) => {
    if (ids.has(question.question_id)) {
      context.addIssue({ code: "custom", path: ["questions", index, "question_id"], message: "问题 ID 必须唯一。" });
    }
    ids.add(question.question_id);
  });
});

export const HumanReviewAnswerSchema = z.object({
  question_id: z.string().min(1).max(100),
  option_id: z.string().min(1).max(100),
  custom_text: z.string().max(4_000).optional(),
}).strict();

export const HumanReviewStatusSchema = z.enum(["waiting", "submitted", "expired", "cancelled"]);

export type HumanReviewQuestionBatch = z.infer<typeof HumanReviewQuestionBatchSchema>;
export type HumanReviewAnswer = z.infer<typeof HumanReviewAnswerSchema>;
export type HumanReviewStatus = z.infer<typeof HumanReviewStatusSchema>;

export interface HumanReviewSnapshot {
  id: string;
  agentRunId: string;
  ownerId: string;
  goalId: string;
  threadId: string;
  schemaVersion: string;
  graphVersion: string;
  questions: HumanReviewQuestionBatch;
  answers: HumanReviewAnswer[];
  status: HumanReviewStatus;
  idempotencyKey: string | null;
  expiresAt: Date | null;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
