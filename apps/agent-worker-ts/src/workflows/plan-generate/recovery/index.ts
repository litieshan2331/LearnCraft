/**
 * 学习路线恢复输出的宽松规范化（自原 workflows/plan-recovery.ts 移入 plan-generate/recovery/；
 * 等价于 Python plan_generate.py 底部的 _normalize_recovery_document 及其辅助函数）。
 *
 * 职责：仅在路线「多轮严格校验都失败」后的兜底恢复阶段使用。把模型可能给出的旧字段名、
 * 字符串难度、非连续 ordinal、非法或重复 node_key、以标题书写的依赖等松散结构，
 * 收敛成当前路线合同的形状；规范化之后仍要经过 LearningPlanDocumentSchema 严格校验，
 * 因此本模块不会放宽合同，只提高恢复阶段的成功率。
 *
 * 与 Python 的差异：Python 的真值语义（空字符串/空数组/空对象均为假）在这里用 pyTruthy/pyOr 显式复刻，
 * 避免 JS 中空数组为真导致取错字段；round 使用「四舍六入五取偶」以与 Python 的 round 一致。
 *
 * 导出：
 * - PlanRecoveryNormalizationError：规范化过程中的结构性失败，path 用于错误消息。
 * - normalizeRecoveryDocument：把恢复阶段的模型文本规范化为候选文档对象。
 * - recoveryText / recoveryStringList：供本模块与测试复用的收敛函数。
 */

import { pyOr, pythonRound } from '../../shared/python-compat.js';

/** 规范化失败时携带稳定路径，调用方把它当作校验路径的一部分。 */
export class PlanRecoveryNormalizationError extends Error {
  constructor(readonly path: string) {
    super(path);
    this.name = 'PlanRecoveryNormalizationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** 提取长度受限的非空文本，并在缺失时提供可读默认值。 */
export function recoveryText(value: unknown, fallback: string, maximum: number): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, maximum) : fallback;
}

/** 将单字符串、列表或对象值收敛为非空字符串列表。 */
export function recoveryStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
  }
  if (isRecord(value)) {
    return Object.values(value)
      .filter((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

/** 将非法或重复 node_key 降级为稳定 chapter 序号键。 */
function recoveryNodeKey(value: unknown, index: number, usedKeys: ReadonlySet<string>): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const normalized = [...raw]
    .map((character) =>
      /^[a-z0-9_]$/.test(character) ? character : '_',
    )
    .join('')
    .replace(/^_+|_+$/g, '');
  let candidate = normalized;
  if (candidate.length === 0 || !/^[a-z]/.test(candidate) || usedKeys.has(candidate)) {
    candidate = 'chapter_' + String(index);
  }
  while (usedKeys.has(candidate)) {
    candidate = candidate + '_' + String(index);
  }
  return candidate.slice(0, 100);
}

/** 将常见字符串或数值难度收敛到 1-5。 */
function recoveryDifficulty(value: unknown, index: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clamp(pythonRound(value), 1, 5);
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    const mapping: Record<string, number> = {
      beginner: 1, basic: 1, '初级': 1, easy: 2,
      intermediate: 3, medium: 3, '中级': 3,
      advanced: 4, hard: 4, '高级': 4, expert: 5,
    };
    const mapped = mapping[normalized];
    if (mapped !== undefined) {
      return mapped;
    }
    if (/^[0-9]+$/.test(normalized)) {
      return clamp(Number.parseInt(normalized, 10), 1, 5);
    }
  }
  return clamp(Math.floor((index + 1) / 2), 1, 5);
}

/** 将时长收敛到路线合同的 5-1440 分钟范围。 */
function recoveryMinutes(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clamp(pythonRound(value), 5, 1_440);
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    return clamp(Number.parseInt(value.trim(), 10), 5, 1_440);
  }
  return 45;
}

/** 将字符串或字符串列表的完成标准规范为非空列表。 */
function recoveryCriteria(value: unknown, title: string): string[] {
  const values = recoveryStringList(value);
  return values.length > 0 ? values.slice(0, 10) : ['能够完成' + title + '的核心示例。'];
}

/** 只保留可解析到当前路线节点的前置依赖。 */
function recoveryPrerequisites(input: {
  rawValues: unknown;
  currentKey: string;
  allKeys: ReadonlySet<string>;
  titleToKey: ReadonlyMap<string, string>;
}): string[] {
  const resolved: string[] = [];
  for (const rawValue of recoveryStringList(input.rawValues)) {
    const key = input.titleToKey.get(rawValue) ?? rawValue;
    if (input.allKeys.has(key) && key !== input.currentKey && !resolved.includes(key)) {
      resolved.push(key);
    }
  }
  return resolved;
}

/**
 * 把恢复阶段的模型文本规范化为候选路线文档。
 * 结构性问题（不是 JSON、不是对象、nodes 不是数组）抛出带路径的异常，由调用方转换为校验路径。
 */
export function normalizeRecoveryDocument(content: string): Record<string, unknown> {
  let rawDocument: unknown;
  try {
    rawDocument = JSON.parse(content);
  } catch {
    throw new PlanRecoveryNormalizationError('response.json');
  }
  if (!isRecord(rawDocument)) {
    throw new PlanRecoveryNormalizationError('response.object');
  }

  const rawNodes = rawDocument.nodes;
  if (!Array.isArray(rawNodes)) {
    throw new PlanRecoveryNormalizationError('nodes');
  }

  const drafts: Array<Record<string, unknown>> = [];
  const usedKeys = new Set<string>();
  const titleToKey = new Map<string, string>();

  rawNodes.forEach((rawNode, position) => {
    const index = position + 1;
    const node = isRecord(rawNode) ? rawNode : {};
    const title = recoveryText(pyOr(node.title, node.name), '第 ' + String(index) + ' 章', 255);
    const nodeKey = recoveryNodeKey(node.node_key, index, usedKeys);
    usedKeys.add(nodeKey);
    titleToKey.set(title, nodeKey);
    drafts.push({
      node_key: nodeKey,
      ordinal: index,
      title,
      node_brief: recoveryText(
        pyOr(node.node_brief, node.description, node.summary),
        '学习' + title + '的关键概念和适用边界。',
        2_000,
      ),
      learning_objective: recoveryText(
        pyOr(node.learning_objective, node.goal, node.objective),
        '能够完成' + title + '的核心学习目标。',
        2_000,
      ),
      rationale: recoveryText(
        pyOr(node.rationale, node.reason),
        title + '承接前置知识并支撑后续章节。',
        2_000,
      ),
      difficulty: recoveryDifficulty(node.difficulty, index),
      estimated_minutes: recoveryMinutes(pyOr(node.estimated_minutes, node.duration_minutes)),
      completion_criteria: recoveryCriteria(
        pyOr(node.completion_criteria, node.completion_criterion),
        title,
      ),
      _raw_prerequisites: pyOr(
        node.prerequisite_node_keys,
        node.dependencies,
        node.prerequisites,
        [],
      ),
    });
  });

  const allKeys = new Set(drafts.map((draft) => String(draft.node_key)));
  drafts.forEach((draft, index) => {
    const rawPrerequisites = draft._raw_prerequisites;
    delete draft._raw_prerequisites;
    let prerequisiteKeys = recoveryPrerequisites({
      rawValues: rawPrerequisites,
      currentKey: String(draft.node_key),
      allKeys,
      titleToKey,
    });
    if (prerequisiteKeys.length === 0 && index > 0) {
      prerequisiteKeys = [String(drafts[index - 1]?.node_key)];
    }
    draft.prerequisite_node_keys = prerequisiteKeys;
  });

  return {
    schema_version: 'learning_plan.v1',
    title: recoveryText(pyOr(rawDocument.title, rawDocument.plan_title), '学习路线', 255),
    summary: recoveryText(pyOr(rawDocument.summary, rawDocument.description), '按章节组织的学习路线。', 2_000),
    nodes: drafts,
  };
}
