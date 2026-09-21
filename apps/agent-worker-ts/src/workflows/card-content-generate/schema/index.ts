/**
 * card_content_generate 输入合同与节点知识内容合同
 * （输入部分自原 card-content-generate.ts 拆分；内容合同来自原 card-content-document.ts，
 * 等价于 Python card_content_generate.py 的 CardContentDocument / _normalize_card_content
 * 及其辅助函数）。
 *
 * 职责：
 * - 输入：定义节点内容生成任务快照的契约（agent_role 固定 node_tutor、logical_session_key
 *   1-200、goal / learner_profile / learning_plan / plan_node 宽松对象，plan_node.id 必填）；
 * - 内容：定义 card_content.v1 的运行时校验（字段与 Web 内部接口 /card-content-result 完全一致），
 *   并把模型常见的宽松输出收敛到该形状。与 Python 不同的是：**规范化在每次解析时都会执行**
 *   （首轮、修复、兜底都一样），这正是 Python CardContentDocument.from_json 的行为。
 *
 * 与 Python 的差异：
 * - 输入：Python 直接取 value.plan_node["id"]，缺失即 KeyError；本实现在输入校验阶段
 *   返回 CARD_CONTENT_INPUT_INVALID。
 * - 内容：Python 的 teaching_memory 是 dict[str, Any]，内层长度上限只在 Web 侧校验；
 *   本实现用与 Web 相同的合同提前校验，因此 key_concepts 超过 300 字符之类的边界会**在本地**
 *   判定为输出非法并进入修复，而不是把请求发到 Web 换取 422（错误码因此可能从
 *   CARD_CONTENT_PERSISTENCE_REJECTED 变为 CARD_CONTENT_OUTPUT_INVALID）。
 *
 * 导出：
 * - CardContentGenerationInputSchema / CardContentGenerationInput：输入合同。
 * - CardContentPitfallDebugSchema / CardContentWorkedExampleSchema / CardContentTeachingMemorySchema
 * - CardContentDocumentSchema / CardContentDocument：节点内容合同与类型。
 * - CardContentParseError：解析或规范化失败，message 与 Python 的 ValueError 文案一致。
 * - parseCardContentDocument：从模型文本解析出受校验的节点内容。
 * - normalizeCardContent：把宽松对象收敛为合同形状（供本模块与测试复用）。
 */

import { z } from 'zod';

import { extractJsonText } from '../../../schemas/assessment-question-set.js';
import { pyOr } from '../../shared/python-compat.js';

export const CardContentGenerationInputSchema = z
  .object({
    agent_role: z.literal('node_tutor'),
    logical_session_key: z.string().min(1).max(200),
    goal: z.record(z.string(), z.unknown()),
    learner_profile: z.record(z.string(), z.unknown()),
    learning_plan: z.record(z.string(), z.unknown()),
    plan_node: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((value, context) => {
    // Python 直接取 value.plan_node["id"]，缺失即 KeyError；这里提前判为输入非法。
    if (typeof value.plan_node.id !== 'string' || value.plan_node.id.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['plan_node', 'id'],
        message: 'plan_node.id 必须是非空字符串。',
      });
    }
  });

export type CardContentGenerationInput = z.infer<typeof CardContentGenerationInputSchema>;

export const CardContentPitfallDebugSchema = z
  .object({
    title: z.string().min(1).max(300),
    cause: z.string().min(1).max(2_000),
    fix: z.string().min(1).max(2_000),
  })
  .strict();

export const CardContentWorkedExampleSchema = z
  .object({
    explanation: z.string().min(1).max(4_000),
    code: z.string().min(1).max(12_000),
    call_sequence: z.array(z.string().min(1).max(500)).min(1).max(50),
    expected_output: z.string().min(1).max(4_000),
  })
  .strict();

export const CardContentTeachingMemorySchema = z
  .object({
    key_concepts: z.array(z.string().min(1).max(300)).min(1).max(30),
    common_mistakes: z.array(z.string().min(1).max(500)).max(30),
    assessment_targets: z.array(z.string().min(1).max(500)).min(1).max(30),
  })
  .strict();

export const CardContentDocumentSchema = z
  .object({
    schema_version: z.literal('card_content.v1'),
    foundation: z.string().min(1).max(12_000),
    worked_example: CardContentWorkedExampleSchema,
    pitfalls_debug: z.array(CardContentPitfallDebugSchema).min(1),
    source_refs: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
    teaching_memory: CardContentTeachingMemorySchema,
  })
  .strict();

export type CardContentDocument = z.infer<typeof CardContentDocumentSchema>;

/**
 * 解析或规范化失败；message 与 Python 的 ValueError 文案保持一致。
 * validationPaths 供 ReAct 会话把字段路径回灌给模型自纠（脱敏，不含模型正文）。
 */
export class CardContentParseError extends Error {
  constructor(message: string, readonly validationPaths: readonly string[] = []) {
    super(message);
    this.name = 'CardContentParseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 提取内容字段并限制长度，缺失时返回安全默认文案（数字按 Python 的 str() 处理）。 */
function contentText(value: unknown, fallback: string, maximum: number): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim().slice(0, maximum);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).slice(0, maximum);
  }
  return fallback;
}

/** 将字符串或列表收敛为有界字符串数组；单项最多 500 字符。 */
function contentTextList(value: unknown, fallback: readonly string[], maximum: number): string[] {
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim().slice(0, 500)];
  }
  if (Array.isArray(value)) {
    const values = value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim().slice(0, 500));
    if (values.length > 0) {
      return values.slice(0, maximum);
    }
  }
  return [...fallback];
}

/** 只保留来源引用中的对象，避免把任意模型值写入引用数组。 */
function contentMappingList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .slice(0, 20)
    .map((item) => ({ ...item }));
}

/** 将常见误区严格收敛为 title、cause、fix 三字段对象数组。 */
function normalizePitfallsDebug(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CardContentParseError('pitfalls_debug 必须是至少包含一项的对象数组。', ['pitfalls_debug']);
  }

  const normalized: Array<Record<string, string>> = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new CardContentParseError(
        'pitfalls_debug.' + String(index) + ' 必须是对象。',
        ['pitfalls_debug.' + String(index)],
      );
    }
    const keys = Object.keys(item).sort();
    if (keys.join(',') !== 'cause,fix,title') {
      throw new CardContentParseError(
        'pitfalls_debug.' + String(index) + ' 只能包含 title、cause、fix。',
        ['pitfalls_debug.' + String(index)],
      );
    }
    const fields: Record<string, string> = {};
    for (const fieldName of ['title', 'cause', 'fix']) {
      const fieldValue = item[fieldName];
      if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
        throw new CardContentParseError(
          'pitfalls_debug.' + String(index) + '.' + fieldName + ' 不能为空。',
          ['pitfalls_debug.' + String(index) + '.' + fieldName],
        );
      }
      fields[fieldName] = fieldValue.trim().slice(0, 2_000);
    }
    normalized.push(fields);
  });
  return normalized;
}

/** 将模型常见的宽松字段收敛为 card_content.v1 的稳定形状。 */
export function normalizeCardContent(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new CardContentParseError('模型内容必须是 JSON 对象。', ['response.object']);
  }

  const workedRaw = pyOr(raw.worked_example, raw.example, raw.workedExample);
  let workedExample: Record<string, unknown>;
  if (isRecord(workedRaw)) {
    workedExample = {
      explanation: contentText(
        pyOr(workedRaw.explanation, workedRaw.description),
        '本示例演示本章节核心概念的基本用法。',
        4_000,
      ),
      code: contentText(
        pyOr(workedRaw.code, workedRaw.snippet),
        '# 请根据本章节目标补充示例代码',
        12_000,
      ),
      call_sequence: contentTextList(
        pyOr(workedRaw.call_sequence, workedRaw.steps),
        ['准备输入', '执行核心步骤', '核对结果'],
        50,
      ),
      expected_output: contentText(
        pyOr(workedRaw.expected_output, workedRaw.output),
        '示例应输出符合章节目标的结果。',
        4_000,
      ),
    };
  } else {
    workedExample = {
      explanation: contentText(workedRaw, '本示例演示本章节核心概念的基本用法。', 4_000),
      code: '# 请根据本章节目标补充示例代码',
      call_sequence: ['准备输入', '执行核心步骤', '核对结果'],
      expected_output: '示例应输出符合章节目标的结果。',
    };
  }

  const memoryRaw = pyOr(raw.teaching_memory, raw.teachingMemory);
  const memory = isRecord(memoryRaw) ? memoryRaw : {};

  return {
    schema_version: 'card_content.v1',
    foundation: contentText(
      pyOr(raw.foundation, raw.content, raw.summary),
      '本章节围绕节点目标建立必要概念，并说明它们之间的关系。',
      12_000,
    ),
    worked_example: workedExample,
    pitfalls_debug: normalizePitfallsDebug(pyOr(raw.pitfalls_debug, raw.pitfalls, raw.common_mistakes)),
    source_refs: contentMappingList(pyOr(raw.source_refs, raw.references)),
    teaching_memory: {
      key_concepts: contentTextList(
        pyOr(memory.key_concepts, memory.concepts),
        ['本章节核心概念'],
        30,
      ),
      common_mistakes: contentTextList(
        pyOr(memory.common_mistakes, memory.mistakes),
        ['忽略边界条件或概念之间的区别'],
        30,
      ),
      assessment_targets: contentTextList(
        pyOr(memory.assessment_targets, memory.targets),
        ['能够解释并应用本章节核心概念'],
        30,
      ),
    },
  };
}

/** 从模型文本解析出受校验的节点内容；JSON 非法、规范化失败或合同不符都抛 CardContentParseError。 */
export function parseCardContentDocument(content: string): CardContentDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonText(content));
  } catch (error) {
    throw new CardContentParseError(
      error instanceof CardContentParseError ? error.message : '模型内容不是合法 JSON。',
      error instanceof CardContentParseError ? error.validationPaths : ['response.json'],
    );
  }

  let normalized: Record<string, unknown>;
  try {
    normalized = normalizeCardContent(raw);
  } catch (error) {
    if (error instanceof CardContentParseError) {
      throw new CardContentParseError(
        error.message,
        error.validationPaths.length > 0 ? error.validationPaths : ['response.json'],
      );
    }
    throw error;
  }

  const parsed = CardContentDocumentSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new CardContentParseError(
      '模型返回的节点内容不符合 card_content.v1。',
      cardContentValidationPaths(parsed.error),
    );
  }
  return parsed.data;
}

/** 把 zod 校验失败收敛为去重后的字段路径；空路径按 response.json 处理。 */
function cardContentValidationPaths(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }> }): string[] {
  const paths: string[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map((segment) => String(segment)).join('.');
    const effective = path.length > 0 ? path : 'response.json';
    if (!paths.includes(effective)) {
      paths.push(effective);
    }
  }
  return paths.length > 0 ? paths : ['response.json'];
}
