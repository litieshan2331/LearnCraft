/**
 * assessment_generate 输入合同（自原 assessment-generate.ts 拆分）。
 *
 * 职责：定义前测题集生成任务快照的契约并做运行时校验：extra 忽略、title/description
 * 等可空、difficulty 默认 normal、diagnostic 题量必须 10-20（与 Python 的 model_validator 一致）。
 *
 * 导出：
 * - AssessmentGenerationInputSchema / AssessmentGenerationInput
 */

import { z } from 'zod';

export const AssessmentGenerationInputSchema = z
  .object({
    topic: z.string().min(1).max(300),
    title: z.string().max(300).nullish(),
    description: z.string().max(2_000).nullish(),
    desired_outcome: z.string().max(2_000).nullish(),
    background: z.string().max(4_000).nullish(),
    overall_experience: z.string().max(1_000).nullish(),
    question_count: z.number().int().min(5).max(20),
    difficulty: z.enum(['normal', 'hard']).default('normal'),
    kind: z.literal('diagnostic'),
  })
  .loose()
  .superRefine((value, context) => {
    // 与 Python 的 model_validator 一致：diagnostic 题量必须为 10-20。
    if (value.question_count < 10 || value.question_count > 20) {
      context.addIssue({
        code: 'custom',
        path: ['question_count'],
        message: 'diagnostic 题量必须为 10-20',
      });
    }
  });

export type AssessmentGenerationInput = z.infer<typeof AssessmentGenerationInputSchema>;
