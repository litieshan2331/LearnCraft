/**
 * 节点内容合同（card_content.v2）与宽松规范化器的单元测试。
 *
 * 重点固化：
 * - files 一个文件一个元素的形状约束，以及「entry_file / call_sequence.file 必须命中 files」
 *   这类跨字段校验（失败路径必须精确，供 ReAct 回灌自纠）；
 * - 语言别名归一化（typescript → ts、py → python、c++ → cpp、json → text 等）与按扩展名推断；
 * - 旧字段名映射、误区数组三字段强约束、来源引用过滤、内层长度上限与默认文案；
 * - 解析入口的错误文案与字段路径。
 */
import { describe, expect, it } from 'vitest';

import {
  CardContentParseError,
  normalizeCardContent,
  parseCardContentDocument,
} from '../src/workflows/card-content-generate/schema/index.js';

function documentRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'card_content.v2',
    foundation: '本章节的基础内容。',
    worked_example: {
      explanation: '示例说明。',
      files: [
        { path: 'src/types/todo.ts', language: 'ts', role: 'types', content: 'export type Todo = { id: number };' },
        { path: 'src/main.ts', language: 'ts', role: 'entry', content: 'console.log(1);' },
      ],
      entry_file: 'src/main.ts',
      call_sequence: [
        { step: 1, file: 'src/main.ts', function: 'main', note: '入口启动' },
        { step: 2, file: 'src/types/todo.ts', function: 'Todo', note: '使用类型' },
      ],
      expected_output: 'src/main.ts › main：控制台输出 1',
    },
    pitfalls_debug: [{ title: '误区', cause: '原因', fix: '修复' }],
    source_refs: [],
    teaching_memory: { key_concepts: ['概念'], common_mistakes: [], assessment_targets: ['目标'] },
    ...overrides,
  };
}

describe('宽松规范化（v2）', () => {
  it('旧字段名映射到 v2 形状：files 一个文件一个元素', () => {
    const document = normalizeCardContent({
      summary: '由 summary 映射来的基础内容。',
      example: {
        description: '示例说明',
        files: [
          { file: 'src/a.ts', lang: 'typescript', code: 'export const a = 1;' },
          { path: 'src/b.py', language: 'py', content: 'print(1)' },
        ],
        entry: 'src/a.ts',
        steps: [{ file: 'src/a.ts', fn: 'a', description: '调用 a' }],
        output: '1',
      },
      common_mistakes: [{ title: '误区', cause: '原因', fix: '修复' }],
      references: [{ url: 'https://example.com' }, '不是对象', 42],
      teachingMemory: { concepts: ['概念'], mistakes: ['错误'], targets: ['目标'] },
    });

    expect(document.schema_version).toBe('card_content.v2');
    expect(document.foundation).toBe('由 summary 映射来的基础内容。');
    expect(document.worked_example).toEqual({
      explanation: '示例说明',
      files: [
        { path: 'src/a.ts', language: 'ts', role: 'module', content: 'export const a = 1;' },
        { path: 'src/b.py', language: 'python', role: 'module', content: 'print(1)' },
      ],
      entry_file: 'src/a.ts',
      call_sequence: [{ step: 1, file: 'src/a.ts', function: 'a', note: '调用 a' }],
      expected_output: '1',
    });
    expect(document.pitfalls_debug).toEqual([{ title: '误区', cause: '原因', fix: '修复' }]);
    expect(document.source_refs).toEqual([{ url: 'https://example.com' }]);
    expect(document.teaching_memory).toEqual({
      key_concepts: ['概念'],
      common_mistakes: ['错误'],
      assessment_targets: ['目标'],
    });
  });

  it('语言别名与扩展名推断都收敛到白名单，未知一律 text', () => {
    const document = normalizeCardContent({
      worked_example: {
        files: [
          { path: 'a.ts', language: 'TypeScript', content: 'const a = 1;' },
          { path: 'b.py', language: 'python3', content: 'print(1)' },
          { path: 'c.cc', language: 'c++', content: 'int main(){}' },
          { path: 'd.json', language: 'json', content: '{}' },
          { path: 'e.unknown', language: 'brainfuck', content: '+++' },
        ],
        entry_file: 'a.ts',
        call_sequence: [{ step: 1, file: 'a.ts', function: 'a', note: 'x' }],
      },
      pitfalls_debug: [{ title: 'a', cause: 'b', fix: 'c' }],
    });

    const files = (document.worked_example as Record<string, unknown>).files as Array<Record<string, unknown>>;
    expect(files.map((file) => file.language)).toEqual(['ts', 'python', 'cpp', 'text', 'text']);
  });

  it('缺少 entry_file 时回落到 role=entry 的文件，再回落到第一个文件', () => {
    const withRole = normalizeCardContent({
      worked_example: {
        files: [
          { path: 'a.ts', language: 'ts', content: 'a' },
          { path: 'b.ts', language: 'ts', role: 'entry', content: 'b' },
        ],
        call_sequence: [{ step: 1, file: 'b.ts', function: 'b', note: 'x' }],
      },
      pitfalls_debug: [{ title: 'a', cause: 'b', fix: 'c' }],
    });
    expect((withRole.worked_example as Record<string, unknown>).entry_file).toBe('b.ts');

    const withoutRole = normalizeCardContent({
      worked_example: {
        files: [{ path: 'a.ts', language: 'ts', content: 'a' }],
        call_sequence: [{ step: 1, file: 'a.ts', function: 'a', note: 'x' }],
      },
      pitfalls_debug: [{ title: 'a', cause: 'b', fix: 'c' }],
    });
    expect((withoutRole.worked_example as Record<string, unknown>).entry_file).toBe('a.ts');
  });

  it('调用顺序缺失 file 时落到入口文件，step 按下标补齐', () => {
    const document = normalizeCardContent({
      worked_example: {
        files: [{ path: 'a.ts', language: 'ts', content: 'a' }],
        entry_file: 'a.ts',
        call_sequence: [{ function: 'a', note: '第一步' }, { function: 'b', note: '第二步' }],
      },
      pitfalls_debug: [{ title: 'a', cause: 'b', fix: 'c' }],
    });

    expect((document.worked_example as Record<string, unknown>).call_sequence).toEqual([
      { step: 1, file: 'a.ts', function: 'a', note: '第一步' },
      { step: 2, file: 'a.ts', function: 'b', note: '第二步' },
    ]);
  });

  it('worked_example 为空对象时给出空 files 与默认文案', () => {
    const document = normalizeCardContent({ worked_example: {}, pitfalls_debug: [{ title: 'a', cause: 'b', fix: 'c' }] });

    expect(document.worked_example).toEqual({
      explanation: '本示例演示本章节核心概念的基本用法。',
      files: [],
      entry_file: '',
      call_sequence: [],
      expected_output: '示例应输出符合章节目标的结果。',
    });
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

describe('解析入口与跨字段校验（v2）', () => {
  it('可以从带 Markdown 包裹的文本中提取 JSON 并通过校验', () => {
    const document = parseCardContentDocument(
      '\n```json\n' + JSON.stringify(documentRaw()) + '\n``\u0060\n',
    );

    expect(document.schema_version).toBe('card_content.v2');
    expect(document.worked_example.files).toHaveLength(2);
    expect(document.worked_example.entry_file).toBe('src/main.ts');
    expect(document.worked_example.call_sequence[0]).toEqual({
      step: 1,
      file: 'src/main.ts',
      function: 'main',
      note: '入口启动',
    });
    expect(document.source_refs).toEqual([]);
  });

  it('JSON 非法或合同不符时抛出解析异常（错误码文案为 v2）', () => {
    expect(() => parseCardContentDocument('不是 JSON')).toThrow(CardContentParseError);
    try {
      parseCardContentDocument(JSON.stringify(documentRaw({ foundation: '' })));
    } catch (error) {
      expect((error as Error).message).toBe('模型返回的节点内容不符合 card_content.v2。');
    }
  });

  it('entry_file 不在 files 中时报出 entry_file 路径', () => {
    try {
      parseCardContentDocument(JSON.stringify(documentRaw({
        worked_example: {
          explanation: 'x',
          files: [{ path: 'src/a.ts', language: 'ts', role: 'entry', content: 'a' }],
          entry_file: 'src/missing.ts',
          call_sequence: [{ step: 1, file: 'src/a.ts', function: 'a', note: 'x' }],
          expected_output: 'src/a.ts › a：x',
        },
      })));
      expect.unreachable('应当校验失败');
    } catch (error) {
      expect(error).toBeInstanceOf(CardContentParseError);
      expect((error as CardContentParseError).validationPaths).toContain('worked_example.entry_file');
    }
  });

  it('call_sequence 引用不存在的文件或 step 不连续时报出对应路径', () => {
    try {
      parseCardContentDocument(JSON.stringify(documentRaw({
        worked_example: {
          explanation: 'x',
          files: [{ path: 'src/a.ts', language: 'ts', role: 'entry', content: 'a' }],
          entry_file: 'src/a.ts',
          call_sequence: [{ step: 2, file: 'src/nope.ts', function: 'a', note: 'x' }],
          expected_output: 'x',
        },
      })));
      expect.unreachable('应当校验失败');
    } catch (error) {
      const paths = (error as CardContentParseError).validationPaths;
      expect(paths).toContain('worked_example.call_sequence.0.step');
      expect(paths).toContain('worked_example.call_sequence.0.file');
    }
  });

  it('文件路径重复被拒绝；未知语言按扩展名收敛而不是报错', () => {
    try {
      parseCardContentDocument(JSON.stringify(documentRaw({
        worked_example: {
          explanation: 'x',
          files: [
            { path: 'src/a.ts', language: 'ts', role: 'entry', content: 'a' },
            { path: 'src/a.ts', language: 'rust', role: 'module', content: 'b' },
          ],
          entry_file: 'src/a.ts',
          call_sequence: [{ step: 1, file: 'src/a.ts', function: 'a', note: 'x' }],
          expected_output: 'x',
        },
      })));
      expect.unreachable('应当校验失败');
    } catch (error) {
      expect((error as CardContentParseError).validationPaths).toContain('worked_example.files.1.path');
    }

    // 归一化会把白名单外的语言收敛成合同内取值（这里是按 .ts 扩展名推断的 ts），因此不会因语言报错。
    const parsed = parseCardContentDocument(JSON.stringify(documentRaw({
      worked_example: {
        explanation: 'x',
        files: [{ path: 'src/a.ts', language: 'rust', role: 'entry', content: 'a' }],
        entry_file: 'src/a.ts',
        call_sequence: [{ step: 1, file: 'src/a.ts', function: 'a', note: 'x' }],
        expected_output: 'x',
      },
    })));
    expect(parsed.worked_example.files[0]?.language).toBe('ts');
  });

  it('文件数超过 8 个或单文件超过 6000 字符时被拒绝', () => {
    const tooManyFiles = Array.from({ length: 9 }, (_, index) => ({
      path: 'src/f' + String(index) + '.ts',
      language: 'ts',
      role: 'module',
      content: 'x',
    }));
    try {
      parseCardContentDocument(JSON.stringify(documentRaw({
        worked_example: {
          explanation: 'x',
          files: tooManyFiles,
          entry_file: 'src/f0.ts',
          call_sequence: [{ step: 1, file: 'src/f0.ts', function: 'f0', note: 'x' }],
          expected_output: 'x',
        },
      })));
      expect.unreachable('应当校验失败');
    } catch (error) {
      expect((error as CardContentParseError).validationPaths).toContain('worked_example.files');
    }

    try {
      parseCardContentDocument(JSON.stringify(documentRaw({
        worked_example: {
          explanation: 'x',
          files: [{ path: 'src/a.ts', language: 'ts', role: 'entry', content: 'x'.repeat(6_001) }],
          entry_file: 'src/a.ts',
          call_sequence: [{ step: 1, file: 'src/a.ts', function: 'a', note: 'x' }],
          expected_output: 'x',
        },
      })));
      expect.unreachable('应当校验失败');
    } catch (error) {
      expect((error as CardContentParseError).validationPaths).toContain('worked_example.files.0.content');
    }
  });

  it('expected_output 保持字符串：不做对象化，也不参与跨字段校验', () => {
    // 提示词要求「文件路径 › 函数名：」前缀，但合同不校验它（已知取舍）。
    const document = parseCardContentDocument(JSON.stringify(documentRaw({
      worked_example: {
        ...(documentRaw().worked_example as Record<string, unknown>),
        expected_output: '没有前缀的纯文本输出说明',
      },
    })));

    expect(document.worked_example.expected_output).toBe('没有前缀的纯文本输出说明');
  });

  it('teaching_memory 缺少 key_concepts 时补默认值后仍可通过校验', () => {
    const document = parseCardContentDocument(JSON.stringify(documentRaw({ teaching_memory: {} })));

    expect(document.teaching_memory.key_concepts).toEqual(['本章节核心概念']);
  });
});
