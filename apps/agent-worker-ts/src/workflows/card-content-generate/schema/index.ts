/**
 * card_content_generate 输入合同与节点知识内容合同（card_content.v2）。
 *
 * 职责：
 * - 输入：定义节点内容生成任务快照的契约（agent_role 固定 node_tutor、logical_session_key
 *   1-200、goal / learner_profile / learning_plan / plan_node 宽松对象，plan_node.id 必填）；
 * - 内容：定义 card_content.**v2** 的运行时校验（字段与 Web 内部接口 /card-content-result 完全一致），
 *   并把模型常见的宽松输出收敛到该形状；规范化在每次解析时都会执行（首轮、修复、兜底都一样）。
 *
 * v2 相对 v1 的变化（2026-09-21 用户确认）：
 * - `worked_example.code: string`（多个文件挤在一段文本里）改为 `worked_example.files[]`
 *   （一个文件一个元素，含 path / language / role / content）；
 * - `worked_example.call_sequence: string[]`（自由文本）改为对象数组
 *   （step / file / function / note），可校验、可点击跳转；
 * - 新增 `worked_example.entry_file`，必须存在于 files 中；
 * - `worked_example.expected_output` **保持字符串不变**（刻意不对象化）：格式靠提示词要求
 *   "文件 › 函数：" 前缀，无法结构化校验、前端不做跳转（已知取舍）。
 *
 * 导出：
 * - CardContentGenerationInputSchema / CardContentGenerationInput：输入合同。
 * - CARD_CONTENT_LANGUAGES / CardContentLanguageSchema：语言标识白名单（text 表示不高亮）。
 * - CARD_CONTENT_FILE_ROLES / CardContentFileRoleSchema：文件角色。
 * - CARD_CONTENT_FILE_LIMITS：文件数、单文件与总长度、调用步数上限。
 * - CardContentFileSchema / CardContentCallStepSchema / CardContentWorkedExampleSchema
 *   / CardContentPitfallDebugSchema / CardContentTeachingMemorySchema：内容子合同。
 * - CardContentDocumentSchema / CardContentDocument：节点内容合同与类型。
 * - CardContentParseError：解析或规范化失败，携带脱敏字段路径供模型自纠。
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

/**
 * 受支持的语言标识；`text` 表示不高亮（配置文件、伪代码、未知语言等的统一兜底）。
 * 前端 Shiki 只注册这些语言中除 text 以外的部分。
 */
export const CARD_CONTENT_LANGUAGES = [
  'js',
  'jsx',
  'ts',
  'tsx',
  'python',
  'java',
  'go',
  'c',
  'cpp',
  'csharp',
  'html',
  'css',
  'scss',
  'sql',
  'text',
] as const;

export const CardContentLanguageSchema = z.enum(CARD_CONTENT_LANGUAGES);
export type CardContentLanguage = z.infer<typeof CardContentLanguageSchema>;

/** 文件在教学示例中的角色；缺省按 module 处理。 */
export const CARD_CONTENT_FILE_ROLES = ['entry', 'types', 'module', 'ui', 'config', 'test', 'other'] as const;
export const CardContentFileRoleSchema = z.enum(CARD_CONTENT_FILE_ROLES).default('module');
export type CardContentFileRole = z.infer<typeof CardContentFileRoleSchema>;

/** 内容规模的硬上限（2026-09-21 用户确认的默认值）。 */
export const CARD_CONTENT_FILE_LIMITS = {
  maxFiles: 8,
  maxFileChars: 6_000,
  maxTotalChars: 24_000,
  maxCallSteps: 20,
} as const;

export const CardContentFileSchema = z
  .object({
    /** 仓库相对路径，例如 src/types/todo.ts；不带 // 前缀、不以 / 开头。 */
    path: z.string().min(1).max(200),
    language: CardContentLanguageSchema,
    role: CardContentFileRoleSchema,
    /** 单个文件的完整内容。 */
    content: z.string().min(1).max(CARD_CONTENT_FILE_LIMITS.maxFileChars),
  })
  .strict();

export const CardContentCallStepSchema = z
  .object({
    /** 从 1 连续编号。 */
    step: z.number().int().min(1).max(CARD_CONTENT_FILE_LIMITS.maxCallSteps),
    /** 必须是 files 中存在的 path。 */
    file: z.string().min(1).max(200),
    /** 该文件中的函数/方法/组件名。 */
    function: z.string().min(1).max(120),
    note: z.string().min(1).max(300),
  })
  .strict();

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
    files: z.array(CardContentFileSchema).min(1).max(CARD_CONTENT_FILE_LIMITS.maxFiles),
    entry_file: z.string().min(1).max(200),
    call_sequence: z.array(CardContentCallStepSchema).min(1).max(CARD_CONTENT_FILE_LIMITS.maxCallSteps),
    /** 保持字符串：格式要求由提示词约束（"文件 › 函数：" 前缀），不做结构化校验。 */
    expected_output: z.string().min(1).max(4_000),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = new Set<string>();
    value.files.forEach((file, index) => {
      if (paths.has(file.path)) {
        context.addIssue({ code: 'custom', path: ['files', index, 'path'], message: '文件路径不能重复。' });
      }
      paths.add(file.path);
    });

    const totalChars = value.files.reduce((sum, file) => sum + file.content.length, 0);
    if (totalChars > CARD_CONTENT_FILE_LIMITS.maxTotalChars) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: '示例代码总长度不能超过 ' + String(CARD_CONTENT_FILE_LIMITS.maxTotalChars) + ' 字符。',
      });
    }

    if (!paths.has(value.entry_file)) {
      context.addIssue({
        code: 'custom',
        path: ['entry_file'],
        message: 'entry_file 必须是 files 中已存在的路径。',
      });
    }

    value.call_sequence.forEach((call, index) => {
      if (call.step !== index + 1) {
        context.addIssue({
          code: 'custom',
          path: ['call_sequence', index, 'step'],
          message: 'step 必须从 1 连续编号。',
        });
      }
      if (!paths.has(call.file)) {
        context.addIssue({
          code: 'custom',
          path: ['call_sequence', index, 'file'],
          message: 'file 必须是 files 中已存在的路径。',
        });
      }
    });
  });

export const CardContentTeachingMemorySchema = z
  .object({
    key_concepts: z.array(z.string().min(1).max(300)).min(1).max(30),
    common_mistakes: z.array(z.string().min(1).max(500)).max(30),
    assessment_targets: z.array(z.string().min(1).max(500)).min(1).max(30),
  })
  .strict();

export const CardContentDocumentSchema = z
  .object({
    schema_version: z.literal('card_content.v2'),
    foundation: z.string().min(1).max(12_000),
    worked_example: CardContentWorkedExampleSchema,
    pitfalls_debug: z.array(CardContentPitfallDebugSchema).min(1),
    source_refs: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
    teaching_memory: CardContentTeachingMemorySchema,
  })
  .strict();

export type CardContentDocument = z.infer<typeof CardContentDocumentSchema>;
export type CardContentFile = z.infer<typeof CardContentFileSchema>;
export type CardContentCallStep = z.infer<typeof CardContentCallStepSchema>;

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

/** 语言别名映射：把模型常见的写法收敛到白名单标识；无法识别一律归到 text（不高亮）。 */
const LANGUAGE_ALIASES: Readonly<Record<string, CardContentLanguage>> = {
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', node: 'js',
  jsx: 'jsx',
  ts: 'ts', typescript: 'ts',
  tsx: 'tsx',
  py: 'python', python: 'python', python3: 'python',
  java: 'java',
  go: 'go', golang: 'go',
  c: 'c', h: 'c',
  cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
  csharp: 'csharp', 'c#': 'csharp', cs: 'csharp', dotnet: 'csharp',
  html: 'html', htm: 'html',
  css: 'css',
  scss: 'scss', sass: 'scss',
  sql: 'sql',
  text: 'text', txt: 'text', plaintext: 'text', md: 'text', markdown: 'text',
  json: 'text', yaml: 'text', yml: 'text', toml: 'text', ini: 'text', env: 'text',
  sh: 'text', shell: 'text', bash: 'text', zsh: 'text', powershell: 'text', ps1: 'text',
  dockerfile: 'text', xml: 'text', vue: 'text', svelte: 'text', graphql: 'text', proto: 'text',
};

/** 按文件扩展名推断语言；识别不了返回 text。 */
function languageFromPath(path: string): CardContentLanguage {
  const match = /\.([A-Za-z0-9]+)$/.exec(path.trim());
  if (match === null) {
    return 'text';
  }
  return LANGUAGE_ALIASES[match[1]!.toLowerCase()] ?? 'text';
}

/** 归一化语言标识：先按别名表，再按路径扩展名，最后回落 text。 */
function normalizeLanguage(value: unknown, path: string): CardContentLanguage {
  if (typeof value === 'string' && value.trim().length > 0) {
    const mapped = LANGUAGE_ALIASES[value.trim().toLowerCase()];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return path.length > 0 ? languageFromPath(path) : 'text';
}

/** 归一化单个文件：只剩字段名别名与类型收敛，其余交给严格校验。 */
function normalizeFile(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const rawPath = pyOr(value.path, value.file, value.filename, value.name);
  const path = typeof rawPath === 'string' ? rawPath.trim().slice(0, 200) : '';
  const rawContent = pyOr(value.content, value.code, value.body, value.source);
  const file: Record<string, unknown> = {
    path: rawPath ?? '',
    language: normalizeLanguage(pyOr(value.language, value.lang), path),
    // role 缺省或非法时统一按 module 处理，保证归一化输出本身就是合同形状。
    role: typeof value.role === 'string' && (CARD_CONTENT_FILE_ROLES as readonly string[]).includes(value.role)
      ? value.role
      : 'module',
    content: typeof rawContent === 'string' ? rawContent : (rawContent ?? ''),
  };
  return file;
}

/** 归一化一个调用步骤；非对象原样返回，交给严格校验报出字段路径。 */
function normalizeCallStep(value: unknown, index: number, fallbackFile: string): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return {
    step: typeof value.step === 'number' ? value.step : index + 1,
    file: pyOr(value.file, value.path) ?? fallbackFile,
    function: pyOr(value.function, value.fn, value.name, value.method) ?? '',
    note: pyOr(value.note, value.description, value.text) ?? '',
  };
}

/**
 * 把模型常见的宽松字段收敛为 card_content.**v2** 的稳定形状。
 * 只做「字段名别名 + 类型收敛 + 语言归一化 + 缺省补齐」，不放宽合同；缺字段仍会由严格校验报出字段路径。
 */
export function normalizeCardContent(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new CardContentParseError('模型内容必须是 JSON 对象。', ['response.object']);
  }

  const workedRaw = pyOr(raw.worked_example, raw.example, raw.workedExample);
  const worked = isRecord(workedRaw) ? workedRaw : {};

  const rawFiles = pyOr(worked.files, worked.file_list, worked.sources);
  const files = Array.isArray(rawFiles) ? rawFiles.map((file) => normalizeFile(file)) : [];

  // 入口文件：优先取显式字段，其次取 role=entry 的文件，最后取第一个文件。
  const explicitEntry = pyOr(worked.entry_file, worked.entry, worked.entryFile);
  const entryCandidate = files.find(
    (file) => isRecord(file) && file.role === 'entry' && typeof file.path === 'string' && file.path.length > 0,
  );
  const firstPath = files.find(
    (file) => isRecord(file) && typeof file.path === 'string' && file.path.length > 0,
  );
  const entryFile = typeof explicitEntry === 'string' && explicitEntry.trim().length > 0
    ? explicitEntry.trim().slice(0, 200)
    : (isRecord(entryCandidate) && typeof entryCandidate.path === 'string'
      ? entryCandidate.path
      : (isRecord(firstPath) && typeof firstPath.path === 'string' ? firstPath.path : ''));

  const rawCallSequence = pyOr(worked.call_sequence, worked.steps);
  const callSequence = Array.isArray(rawCallSequence)
    ? rawCallSequence.map((step, index) => normalizeCallStep(step, index, entryFile))
    : [];

  const workedExample: Record<string, unknown> = {
    explanation: contentText(
      pyOr(worked.explanation, worked.description),
      '本示例演示本章节核心概念的基本用法。',
      4_000,
    ),
    files,
    entry_file: entryFile,
    call_sequence: callSequence,
    expected_output: contentText(
      pyOr(worked.expected_output, worked.output),
      '示例应输出符合章节目标的结果。',
      4_000,
    ),
  };

  const memoryRaw = pyOr(raw.teaching_memory, raw.teachingMemory);
  const memory = isRecord(memoryRaw) ? memoryRaw : {};

  return {
    schema_version: 'card_content.v2',
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
      '模型返回的节点内容不符合 card_content.v2。',
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
