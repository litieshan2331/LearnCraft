/**
 * 题集校验与元数据映射的单元测试（对应 shared/question-set-validation.ts）。
 *
 * 重点固化：围栏剥离、题量与合同的严格校验、只返回脱敏字段路径，
 * 以及 search_extract 与 recovery_stage 的语义映射。
 */
import { describe, expect, it } from 'vitest';

import {
  recoveryStageLabel,
  searchExtractLabel,
  validateQuestionSet,
} from '../src/workflows/shared/question-set-validation.js';

function question(index: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: '第 ' + String(index) + ' 题',
    options: [{ key: 'A', text: '选项 A' }, { key: 'B', text: '选项 B' }],
    answer_key: 'A',
    explanation: '解析',
    skill_tags: [],
    max_score: 1,
    ...extra,
  };
}

function questionSetJson(count = 3, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 'assessment.single_choice.v1',
    questions: Array.from({ length: count }, (_, index) => question(index + 1, extra)),
  });
}

describe('validateQuestionSet', () => {
  it('通过合法题集并剥离 Markdown 围栏', () => {
    const result = validateQuestionSet('```json\n' + questionSetJson(5) + '\n```', 5);

    expect(result.paths).toEqual([]);
    expect(result.value?.questions).toHaveLength(5);
  });

  it('题量低于合同下限（5 题）时返回 questions 路径', () => {
    const result = validateQuestionSet(questionSetJson(3), 3);

    expect(result.value).toBeNull();
    expect(result.paths).toEqual(['questions']);
  });

  it('题量不一致时返回 questions 路径', () => {
    const result = validateQuestionSet(questionSetJson(2), 3);

    expect(result.value).toBeNull();
    expect(result.paths).toEqual(['questions']);
  });

  it('非法 JSON 时返回 response.json，且不回显模型正文', () => {
    const result = validateQuestionSet('不是 JSON 的内容', 3);

    expect(result.value).toBeNull();
    expect(result.paths).toEqual(['response.json']);
  });

  it('合同不符时返回去重后的字段路径（例如 answer_key 引用不存在的选项）', () => {
    const result = validateQuestionSet(questionSetJson(3, { answer_key: 'Z' }), 3);

    expect(result.value).toBeNull();
    expect(result.paths.length).toBeGreaterThan(0);
    expect(result.paths.every((path) => typeof path === 'string' && path.length > 0)).toBe(true);
  });
});

describe('元数据映射', () => {
  it('search_extract 由工具调用数决定', () => {
    expect(searchExtractLabel(0)).toBe('not_used');
    expect(searchExtractLabel(2)).toBe('tavily_search_then_extract');
  });

  it('recovery_stage 按工具使用与自纠情况映射为语义兼容取值', () => {
    expect(recoveryStageLabel({ toolCallCount: 0, validationFailures: 0 })).toBe('initial');
    expect(recoveryStageLabel({ toolCallCount: 0, validationFailures: 1 })).toBe('repair');
    expect(recoveryStageLabel({ toolCallCount: 1, validationFailures: 0 })).toBe('tavily_recovery');
    expect(recoveryStageLabel({ toolCallCount: 2, validationFailures: 3 })).toBe('tavily_recovery');
  });
});
