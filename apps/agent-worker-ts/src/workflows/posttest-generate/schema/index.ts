/**
 * posttest_generate 输入合同（自原 posttest-generate.ts 拆分）。
 *
 * 职责：定义节点后测生成任务快照的契约并做运行时校验：extra 禁止、kind 固定 post_test、
 * 题量 5-10、difficulty 默认 normal，plan_node_id 与 source_card_content_id 必填。
 *
 * 导出：
 * - PosttestGenerationInputSchema / PosttestGenerationInput
 */

import { z } from 'zod';

export const PosttestGenerationInputSchema = z
  .object({
    topic: z.string().min(1).max(300),
    question_count: z.number().int().min(5).max(10),
    difficulty: z.enum(['normal', 'hard']).default('normal'),
    kind: z.literal('post_test'),
    plan_node_id: z.string().min(1).max(64),
    source_card_content_id: z.string().min(1).max(64),
  })
  .strict();

export type PosttestGenerationInput = z.infer<typeof PosttestGenerationInputSchema>;
