/**
 * Assessment 生成接口的 Zod 请求契约。
 *
 * 导出：
 * - assessmentGenerationRequestSchema：校验前测/后测题量、难度和路线关联。
 */

import { z } from "zod";

export const assessmentGenerationRequestSchema = z.object({
  kind: z.enum(["diagnostic", "post_test"]),
  question_count: z.number().int().min(5).max(20),
  difficulty: z.enum(["normal", "hard"]).default("normal"),
  plan_id: z.uuid("学习路线 ID 必须是 UUID。").nullable().optional().transform((value) => value ?? null),
}).strict().superRefine((value, context) => {
  if (value.kind === "diagnostic") {
    if (value.question_count < 10 || value.question_count > 20) {
      context.addIssue({ code: "custom", path: ["question_count"], message: "前测题目数量必须为 10-20 题。" });
    }
    if (value.plan_id !== null) {
      context.addIssue({ code: "custom", path: ["plan_id"], message: "前测不需要关联学习路线。" });
    }
  }

  if (value.kind === "post_test") {
    if (value.question_count < 5 || value.question_count > 10) {
      context.addIssue({ code: "custom", path: ["question_count"], message: "后测题目数量必须为 5-10 题。" });
    }
    if (!value.plan_id) {
      context.addIssue({ code: "custom", path: ["plan_id"], message: "后测必须关联已有学习路线。" });
    }
  }
});

export type AssessmentGenerationRequestBody = z.infer<typeof assessmentGenerationRequestSchema>;
