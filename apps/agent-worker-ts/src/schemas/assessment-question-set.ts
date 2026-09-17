/**
 * 题集业务契约（模型结构化输出与内部回写共用的运行时校验）。
 *
 * 职责：与 Python 的 AssessmentQuestionSet 及 Web 侧 assessment-result 路由的 zod schema 保持一致，
 * 用于校验模型返回的题集 JSON。对象一律 strict（等价 extra="forbid"），字段为 snake_case。
 *
 * 与 Python 对齐的三处细节：
 * 1. schema_version 有默认值（模型可以省略，与 Pydantic 的默认值一致）；
 * 2. prompt 与 explanation 在通过长度约束后执行 Markdown 双重转义换行还原；
 * 3. answer_key 必须引用已有选项。
 *
 * 已知差异：本实现对 skill_tags 的元素施加 min(1).max(100)，Python 未限制元素长度；
 * 该限制与 Web 路由一致（路由才是最终裁判），因此更早失败、错误更清晰。
 *
 * 导出：
 * - AssessmentOptionSchema / AssessmentQuestionSchema / AssessmentQuestionSetSchema
 * - normalizeDoubleEscapedMarkdownNewlines：双重转义换行还原
 * - extractJsonText：剥离 Markdown 代码围栏后取出 JSON 文本。
 */

import { z } from 'zod';

export const ASSESSMENT_SCHEMA_VERSION = 'assessment.single_choice.v1';

/** 三连反引号围栏；用 fromCharCode 构造，避免源码中出现字面围栏字符。 */
const CODE_FENCE = String.fromCharCode(96).repeat(3);

/**
 * 还原被模型双重转义的 Markdown 换行（等价于 Python 的 _normalize_double_escaped_markdown_newlines）。
 * 仅在“没有真实换行、但存在字面 \n 且含代码围栏”时触发，避免误改代码块内容。
 */
export function normalizeDoubleEscapedMarkdownNewlines(value: string): string {
  const escapedNewline = String.fromCharCode(92) + 'n';
  const escapedCarriageReturn = String.fromCharCode(92) + 'r' + escapedNewline;
  const escapedBackslash = String.fromCharCode(92) + String.fromCharCode(92);
  if (value.includes('\n') || !value.includes(escapedNewline) || !value.includes(CODE_FENCE)) {
    return value;
  }

  let normalized = '';
  let index = 0;
  while (index < value.length) {
    if (value.startsWith(escapedCarriageReturn, index)) {
      normalized += '\n';
      index += escapedCarriageReturn.length;
      continue;
    }
    if (value.startsWith(escapedNewline, index)) {
      normalized += '\n';
      index += escapedNewline.length;
      continue;
    }
    if (value.startsWith(escapedBackslash, index)) {
      normalized += String.fromCharCode(92);
      index += escapedBackslash.length;
      continue;
    }
    normalized += value[index];
    index += 1;
  }
  return normalized;
}

export const AssessmentOptionSchema = z
  .object({
    key: z.string().regex(/^[A-F]$/),
    text: z.string().min(1).max(500),
  })
  .strict();

export const AssessmentQuestionSchema = z
  .object({
    prompt: z.string().min(1).max(2_000).transform(normalizeDoubleEscapedMarkdownNewlines),
    options: z.array(AssessmentOptionSchema).min(2).max(6),
    answer_key: z.string().regex(/^[A-F]$/),
    explanation: z.string().min(1).max(2_000).transform(normalizeDoubleEscapedMarkdownNewlines),
    skill_tags: z.array(z.string().min(1).max(100)).max(10).default([]),
    max_score: z.number().positive().max(100).default(1),
  })
  .strict()
  .superRefine((question, context) => {
    if (!question.options.some((option) => option.key === question.answer_key)) {
      context.addIssue({
        code: 'custom',
        path: ['answer_key'],
        message: 'answer_key 必须引用已有选项。',
      });
    }
  });

export const AssessmentQuestionSetSchema = z
  .object({
    // 与 Python 一致：schema_version 可省略，省略时取固定值。
    schema_version: z.literal(ASSESSMENT_SCHEMA_VERSION).default(ASSESSMENT_SCHEMA_VERSION),
    questions: z.array(AssessmentQuestionSchema).min(5).max(20),
  })
  .strict();

export type AssessmentOption = z.infer<typeof AssessmentOptionSchema>;
export type AssessmentQuestion = z.infer<typeof AssessmentQuestionSchema>;
export type AssessmentQuestionSet = z.infer<typeof AssessmentQuestionSetSchema>;

/** 取出模型输出中的 JSON 文本：仅剥离 json 或裸代码围栏。 */
export function extractJsonText(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith(CODE_FENCE)) {
    return trimmed;
  }
  const openPattern = new RegExp('^' + CODE_FENCE + '(?:json)?[ \\t]*\\r?\\n?', 'i');
  const closePattern = new RegExp(CODE_FENCE + '[ \\t]*$');
  return trimmed.replace(openPattern, '').replace(closePattern, '').trim();
}
