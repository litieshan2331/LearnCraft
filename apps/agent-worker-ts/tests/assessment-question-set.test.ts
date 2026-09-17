/**
 * 题集契约的单元测试：字段合同、strict 语义、答案引用校验与代码围栏剥离。
 */
import { describe, expect, it } from 'vitest';

import {
  AssessmentQuestionSetSchema,
  extractJsonText,
} from '../src/schemas/assessment-question-set.js';

const FENCE = String.fromCharCode(96).repeat(3);

/** 题集契约要求 5-20 题，因此测试统一生成 5 道题。 */
function questionSet(count = 5, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'assessment.single_choice.v1',
    questions: Array.from({ length: count }, (_, index) =>
      question({ prompt: '第 ' + String(index + 1) + ' 题：以下哪个是类型断言语法？', ...overrides }),
    ),
  };
}

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: '以下哪个是 TypeScript 的类型断言语法？',
    options: [
      { key: 'A', text: 'value as string' },
      { key: 'B', text: 'value: string' },
    ],
    answer_key: 'A',
    explanation: 'as 语法用于类型断言。',
    skill_tags: ['typescript'],
    max_score: 1,
    ...overrides,
  };
}

describe('AssessmentQuestionSetSchema', () => {
  it('通过合法题集并为缺失字段补默认值', () => {
    const parsed = AssessmentQuestionSetSchema.safeParse(questionSet(5, { skill_tags: undefined, max_score: undefined }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.questions[0]?.skill_tags).toEqual([]);
    expect(parsed.success && parsed.data.questions[0]?.max_score).toBe(1);
  });

  it('answer_key 必须引用已有选项', () => {
    const parsed = AssessmentQuestionSetSchema.safeParse(questionSet(5, { answer_key: 'C' }));
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path.join('.')).toBe('questions.0.answer_key');
  });

  it('多余字段按 strict 语义拒绝', () => {
    expect(AssessmentQuestionSetSchema.safeParse(questionSet(5, { extra: 'x' })).success).toBe(false);
    expect(
      AssessmentQuestionSetSchema.safeParse({ ...questionSet(), unexpected: true }).success,
    ).toBe(false);
  });

  it('schema_version 必须是固定字面量', () => {
    const parsed = AssessmentQuestionSetSchema.safeParse({ ...questionSet(), schema_version: 'assessment.v2' });
    expect(parsed.success).toBe(false);
  });
});

describe('extractJsonText', () => {
  it('剥离 json 围栏与裸围栏', () => {
    expect(extractJsonText(FENCE + 'json\n{"a":1}\n' + FENCE)).toBe('{"a":1}');
    expect(extractJsonText(FENCE + '\n{"a":1}\n' + FENCE)).toBe('{"a":1}');
  });

  it('未包裹围栏时原样返回', () => {
    expect(extractJsonText('  {"a":1}  ')).toBe('{"a":1}');
  });
});
