/**
 * 节点内容合同与宽松规范化器的单元测试
 * （对应 Python card_content_generate.py 的 CardContentDocument / _normalize_card_content）。
 *
 * 重点固化：旧字段名映射、空对象回落（Python 真值语义）、误区数组的三字段强约束与错误文案、
 * 来源引用过滤、内层长度上限与默认文案，以及解析失败时的统一异常。
 */
import { describe, expect, it } from 'vitest';

import {
  CardContentParseError,
  normalizeCardContent,
  parseCardContentDocument,
} from '../src/workflows/card-content-generate/schema/index.js';

function documentRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'card_content.v1',
    foundation: '本章节的基础内容。',
    worked_example: {
      explanation: '示例说明。',
      code: 'print(1)',
      call_sequence: ['准备输入'],
      expected_output: '1',
    },
    pitfalls_debug: [{ title: '误区', cause: '原因', fix: '修复' }],
    source_refs: [],
    teaching_memory: { key_concepts: ['概念'], common_mistakes: [], assessment_targets: ['目标'] },
    ...overrides,
  };
}

describe('宽松规范化', () => {
  it('旧字段名全部映射到当前合同', () => {
    const document = normalizeCardContent({
      summary: '由 summary 映射来的基础内容。',
      example: { description: '示例说明', snippet: 'print(2)', steps: ['准备', '执行'], output: '2' },
      common_mistakes: [{ title: '误区', cause: '原因', fix: '修复' }],
      references: [{ url: 'https://example.com' }, '不是对象', 42],
      teachingMemory: { concepts: ['概念'], mistakes: ['错误'], targets: ['目标'] },
    });

    expect(document.schema_version).toBe('card_content.v1');
    expect(document.foundation).toBe('由 summary 映射来的基础内容。');
    expect(document.worked_example).toEqual({
      explanation: '示例说明',
      code: 'print(2)',
      call_sequence: ['准备', '执行'],
      expected_output: '2',
    });
    expect(document.pitfalls_debug).toEqual([{ title: '误区', cause: '原因', fix: '修复' }]);
    // 只保留对象类型的引用。
    expect(document.source_refs).toEqual([{ url: 'https://example.com' }]);
    expect(document.teaching_memory).toEqual({
      key_concepts: ['概念'],
      common_mistakes: ['错误'],
      assessment_targets: ['目标'],
    });
  });

  it('worked_example 为空对象时回落默认文案（Python 中空对象为假）', () => {
    const document = normalizeCardContent({ worked_example: {}, pitfalls_debug: [{ title: 'a', cause: 'b', fix: 'c' }] });

    expect(document.worked_example).toEqual({
      explanation: '本示例演示本章节核心概念的基本用法。',
      code: '# 请根据本章节目标补充示例代码',
      call_sequence: ['准备输入', '执行核心步骤', '核对结果'],
      expected_output: '示例应输出符合章节目标的结果。',
    });
  });

  it('worked_example 是字符串时按整体说明处理，其余字段使用默认值', () => {
    const document = normalizeCardContent({
      worked_example: '把示例写成了一段话',
      pitfalls_debug: [{ title: 'a', cause: 'b', fix: 'c' }],
    });

    expect((document.worked_example as Record<string, unknown>).explanation).toBe('把示例写成了一段话');
    expect((document.worked_example as Record<string, unknown>).code).toBe('# 请根据本章节目标补充示例代码');
  });

  it('缺失的内容字段使用默认文案，数字按字符串处理，单项最多 500 字符', () => {
    const longText = 'x'.repeat(600);
    const document = normalizeCardContent({
      foundation: 12345,
      pitfalls_debug: [{ title: 'a', cause: 'b', fix: 'c' }],
      teaching_memory: { key_concepts: [longText, '', 7] },
    });

    expect(document.foundation).toBe('12345');
    const memory = document.teaching_memory as Record<string, unknown>;
    expect(memory.key_concepts).toEqual(['x'.repeat(500)]);
    expect(memory.common_mistakes).toEqual(['忽略边界条件或概念之间的区别']);
    expect(memory.assessment_targets).toEqual(['能够解释并应用本章节核心概念']);
  });

  it('误区数组必须是非空对象数组，且每项只能有 title、cause、fix', () => {
    expect(() => normalizeCardContent({ pitfalls_debug: [] })).toThrow(CardContentParseError);
    expect(() => normalizeCardContent({ pitfalls_debug: ['文本'] })).toThrow(CardContentParseError);

    try {
      normalizeCardContent({ pitfalls_debug: [{ title: 'a', cause: 'b', fix: 'c', extra: 'd' }] });
    } catch (error) {
      expect((error as Error).message).toBe('pitfalls_debug.0 只能包含 title、cause、fix。');
    }
    try {
      normalizeCardContent({ pitfalls_debug: [{ title: 'a', cause: '  ', fix: 'c' }] });
    } catch (error) {
      expect((error as Error).message).toBe('pitfalls_debug.0.cause 不能为空。');
    }
  });

  it('顶层不是对象时直接失败', () => {
    expect(() => normalizeCardContent([1, 2])).toThrow(CardContentParseError);
    expect(() => normalizeCardContent('文本')).toThrow(CardContentParseError);
  });
});

describe('解析入口', () => {
  it('可以从带 Markdown 包裹的文本中提取 JSON 并通过校验', () => {
    const document = parseCardContentDocument(
      '\n\u0060\u0060\u0060json\n' + JSON.stringify(documentRaw()) + '\n\u0060\u0060\u0060\n',
    );

    expect(document.schema_version).toBe('card_content.v1');
    expect(document.foundation).toBe('本章节的基础内容。');
    expect(document.source_refs).toEqual([]);
  });

  it('JSON 非法或合同不符时抛出解析异常', () => {
    expect(() => parseCardContentDocument('不是 JSON')).toThrow(CardContentParseError);
    try {
      parseCardContentDocument(JSON.stringify(documentRaw({ foundation: '' })));
    } catch (error) {
      expect((error as Error).message).toBe('模型返回的节点内容不符合 card_content.v1。');
    }
  });

  it('teaching_memory 缺少 key_concepts 时补默认值后仍可通过校验', () => {
    const document = parseCardContentDocument(JSON.stringify(documentRaw({ teaching_memory: {} })));

    expect(document.teaching_memory.key_concepts).toEqual(['本章节核心概念']);
  });
});
