/**
 * 节点后测生成接口的 Zod 请求契约。
 *
 * 导出：
 * - posttestGenerationRequestSchema：校验后测题量和难度。
 */

import { z } from "zod";

export const posttestGenerationRequestSchema = z.object({
  question_count: z.number().int().min(5).max(10),
  difficulty: z.enum(["normal", "hard"]).default("normal"),
}).strict();

export type PosttestGenerationRequestBody = z.infer<typeof posttestGenerationRequestSchema>;