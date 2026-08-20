/**
 * Assessment 作答提交与历史查询的 Zod 请求契约。
 *
 * 导出：
 * - assessmentAttemptSubmissionRequestSchema：校验完整单选题作答。
 * - assessmentAttemptPathSchema、assessmentSubmissionIdempotencyKeySchema：校验路径和幂等键。
 */

import { z } from "zod";

const selectedAnswerSchema = z.object({
  assessment_item_id: z.uuid("题目 ID 必须是 UUID。"),
  selected_option_key: z.string().regex(/^[A-F]$/, "请选择有效选项。"),
}).strict();

export const assessmentAttemptSubmissionRequestSchema = z.object({
  answers: z.array(selectedAnswerSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  const seenItemIds = new Set<string>();
  for (const [index, answer] of value.answers.entries()) {
    if (seenItemIds.has(answer.assessment_item_id)) {
      context.addIssue({
        code: "custom",
        path: ["answers", index, "assessment_item_id"],
        message: "同一道题不能重复提交答案。",
      });
    }
    seenItemIds.add(answer.assessment_item_id);
  }
});

export const assessmentAttemptPathSchema = z.object({
  attempt_id: z.uuid("作答 ID 必须是 UUID。"),
});

export const assessmentSubmissionIdempotencyKeySchema = z.uuid(
  "Idempotency-Key 必须是 UUID。",
);

export type AssessmentAttemptSubmissionRequestBody = z.infer<
  typeof assessmentAttemptSubmissionRequestSchema
>;
