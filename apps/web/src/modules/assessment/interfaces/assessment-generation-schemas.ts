/**
 * Assessment 生成接口的 Zod 请求契约。
 *
 * 导出：
 * - assessmentGenerationRequestSchema：校验前测题量和难度。
 */

import { z } from "zod";

export const assessmentGenerationRequestSchema = z.object({
  kind: z.literal("diagnostic"),
  question_count: z.number().int().min(10).max(20),
  difficulty: z.enum(["normal", "hard"]).default("normal"),
}).strict();

export type AssessmentGenerationRequestBody = z.infer<typeof assessmentGenerationRequestSchema>;
