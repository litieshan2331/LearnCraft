/**
 * 学习路线恢复规范化器的单元测试（对应 Python plan_generate.py 的 _normalize_recovery_document 与辅助函数）。
 *
 * 重点固化：旧字段名映射、node_key 降级与去重、难度与时长收敛（含 Python round 的半值行为）、
 * 以标题书写的依赖解析、缺失依赖时的顺序链兜底，以及结构性失败时给出的校验路径。
 */
import { describe, expect, it } from 'vitest';

import {
  PlanRecoveryNormalizationError,
  normalizeRecoveryDocument,
  recoveryStringList,
  recoveryText,
} from '../src/workflows/plan-recovery.js';

function nodesOf(document: Record<string, unknown>): Array<Record<string, unknown>> {
  return document.nodes as Array<Record<string, unknown>>;
}

describe('文本与列表收敛', () => {
  it('recoveryText 取去除首尾空白后的截断文本，空值走默认值', () => {
    expect(recoveryText('  标题  ', '默认', 255)).toBe('标题');
    expect(recoveryText('   ', '默认', 255)).toBe('默认');
    expect(recoveryText(123, '默认', 255)).toBe('默认');
    expect(recoveryText('abcdef', '默认', 3)).toBe('abc');
  });

  it('recoveryStringList 支持字符串、列表与对象三种形态', () => {
    expect(recoveryStringList(' 一条 ')).toEqual(['一条']);
    expect(recoveryStringList([' a ', '', 3, 'b'])).toEqual(['a', 'b']);
    expect(recoveryStringList({ a: ' x ', b: 5, c: null })).toEqual(['x', '5']);
    expect(recoveryStringList(undefined)).toEqual([]);
  });
});

describe('规范化', () => {
  it('把旧字段、字符串难度与时长收敛为当前合同', () => {
    const document = normalizeRecoveryDocument(JSON.stringify({
      plan_title: '旧版路线标题',
      description: '旧版摘要字段。',
      nodes: [
        { name: '第一章 变量', description: '变量说明', goal: '会定义变量', reason: '打基础', difficulty: 'beginner', duration_minutes: '30' },
        { title: '第二章 函数', summary: '函数说明', objective: '会写函数', difficulty: 'hard', estimated_minutes: 90, dependencies: ['第一章 变量'] },
        { title: '第三章 类', difficulty: 9, estimated_minutes: 3, completion_criteria: '能写类' },
      ],
    }));

    expect(document.title).toBe('旧版路线标题');
    expect(document.summary).toBe('旧版摘要字段。');
    expect(document.schema_version).toBe('learning_plan.v1');

    const nodes = nodesOf(document);
    expect(nodes.map((node) => node.node_key)).toEqual(['chapter_1', 'chapter_2', 'chapter_3']);
    expect(nodes.map((node) => node.ordinal)).toEqual([1, 2, 3]);
    expect(nodes[0]).toMatchObject({
      title: '第一章 变量',
      node_brief: '变量说明',
      learning_objective: '会定义变量',
      rationale: '打基础',
      difficulty: 1,
      estimated_minutes: 30,
      prerequisite_node_keys: [],
    });
    // 标题形式的依赖解析为对应 node_key；难度与时长被夹到合同范围内。
    expect(nodes[1]).toMatchObject({ difficulty: 4, estimated_minutes: 90, prerequisite_node_keys: ['chapter_1'] });
    expect(nodes[2]).toMatchObject({ difficulty: 5, estimated_minutes: 5, prerequisite_node_keys: ['chapter_2'] });
    expect(nodes[2]?.completion_criteria).toEqual(['能写类']);
  });

  it('非法或重复的 node_key 降级为 chapter 序号键，缺失的完成标准使用默认文案', () => {
    const document = normalizeRecoveryDocument(JSON.stringify({
      nodes: [
        { node_key: '合法键', title: 'A' },
        { node_key: 'dup_key', title: 'B' },
        { node_key: 'dup_key', title: 'C' },
        { node_key: 'Dup_Key', title: 'D' },
      ],
    }));

    const nodes = nodesOf(document);
    // 与 Python 一致：键冲突时先整体替换为 chapter_<index>，只有替换键也被占用才会再追加序号。
    expect(nodes.map((node) => node.node_key)).toEqual(['chapter_1', 'dup_key', 'chapter_3', 'chapter_4']);
    expect(nodes[0]?.completion_criteria).toEqual(['能够完成A的核心示例。']);
  });

  it('难度与时长使用 Python round 的银行家舍入，并支持数字字符串', () => {
    const document = normalizeRecoveryDocument(JSON.stringify({
      nodes: [
        { title: 'A', difficulty: 2.5, estimated_minutes: 7.5 },
        { title: 'B', difficulty: 3.5, estimated_minutes: '120' },
        { title: 'C', difficulty: '中级', estimated_minutes: '不是数字' },
      ],
    }));

    const nodes = nodesOf(document);
    expect(nodes[0]).toMatchObject({ difficulty: 2, estimated_minutes: 8 });
    expect(nodes[1]).toMatchObject({ difficulty: 4, estimated_minutes: 120 });
    expect(nodes[2]).toMatchObject({ difficulty: 3, estimated_minutes: 45 });
  });

  it('无有效依赖且不是首节点时，顺序链到前一章', () => {
    const document = normalizeRecoveryDocument(JSON.stringify({
      nodes: [
        { title: 'A', prerequisites: ['不存在的键'] },
        { title: 'B', dependencies: ['B'] },
        { title: 'C' },
      ],
    }));

    const nodes = nodesOf(document);
    expect(nodes[0]?.prerequisite_node_keys).toEqual([]);
    // 自依赖被过滤后落到顺序链；第三节没有依赖则接上一节。
    expect(nodes[1]?.prerequisite_node_keys).toEqual(['chapter_1']);
    expect(nodes[2]?.prerequisite_node_keys).toEqual(['chapter_2']);
  });

  it('非 JSON、非对象与 nodes 非数组时抛出带路径的异常', () => {
    expect(() => normalizeRecoveryDocument('不是 JSON')).toThrow(PlanRecoveryNormalizationError);
    try {
      normalizeRecoveryDocument('不是 JSON');
    } catch (error) {
      expect((error as PlanRecoveryNormalizationError).path).toBe('response.json');
    }
    try {
      normalizeRecoveryDocument('[1, 2]');
    } catch (error) {
      expect((error as PlanRecoveryNormalizationError).path).toBe('response.object');
    }
    try {
      normalizeRecoveryDocument('{"nodes": {}}');
    } catch (error) {
      expect((error as PlanRecoveryNormalizationError).path).toBe('nodes');
    }
  });
});
