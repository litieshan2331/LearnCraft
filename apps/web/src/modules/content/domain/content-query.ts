/**
 * 节点知识内容查询领域契约。
 *
 * 导出：
 * - CARD_CONTENT_LANGUAGES / CardContentLanguage：示例文件的语言白名单（text 表示不高亮）。
 * - CARD_CONTENT_FILE_ROLES / CardContentFileRole：示例文件角色。
 * - CARD_CONTENT_LIMITS：文件数、单文件/总长度、调用步数上限（与 Worker、内部接口一致）。
 * - languageFromPath / normalizeCardContentLanguage：语言标识归一化（读侧归一化器共用）。
 * - CardContentFileView / CardContentCallStepView / CardContentWorkedExampleView：读侧视图模型。
 * - CardContentSnapshot：可供当前用户阅读的已成功内容快照。
 * - CardContentQueryRepository：按所有者读取已成功节点内容的持久化端口。
 * - CardContentQueryServiceError：内容查询稳定错误。
 */

/** 语言白名单：与 Worker 合同、内部接口校验、前端 Shiki 注册保持一致。 */
export const CARD_CONTENT_LANGUAGES = [
  "js",
  "jsx",
  "ts",
  "tsx",
  "python",
  "java",
  "go",
  "c",
  "cpp",
  "csharp",
  "html",
  "css",
  "scss",
  "sql",
  "text",
] as const;

export type CardContentLanguage = (typeof CARD_CONTENT_LANGUAGES)[number];

export const CARD_CONTENT_FILE_ROLES = [
  "entry",
  "types",
  "module",
  "ui",
  "config",
  "test",
  "other",
] as const;

export type CardContentFileRole = (typeof CARD_CONTENT_FILE_ROLES)[number];

/** 内容规模上限：与 Worker 合同一致。 */
export const CARD_CONTENT_LIMITS = {
  maxFiles: 8,
  maxFileChars: 6_000,
  maxTotalChars: 24_000,
  maxCallSteps: 20,
} as const;

/** 语言别名 → 白名单标识；识别不了归到 text（不高亮）。 */
const LANGUAGE_ALIASES: Readonly<Record<string, CardContentLanguage>> = {
  js: "js", javascript: "js", mjs: "js", cjs: "js", node: "js",
  jsx: "jsx",
  ts: "ts", typescript: "ts",
  tsx: "tsx",
  py: "python", python: "python", python3: "python",
  java: "java",
  go: "go", golang: "go",
  c: "c", h: "c",
  cpp: "cpp", "c++": "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp",
  csharp: "csharp", "c#": "csharp", cs: "csharp", dotnet: "csharp",
  html: "html", htm: "html",
  css: "css",
  scss: "scss", sass: "scss",
  sql: "sql",
};

/** 按扩展名推断语言；识别不了返回 text。 */
export function languageFromPath(path: string): CardContentLanguage {
  const match = /\.([A-Za-z0-9]+)$/.exec(path.trim());
  if (match === null) {
    return "text";
  }
  return LANGUAGE_ALIASES[match[1]!.toLowerCase()] ?? "text";
}

/** 归一化语言标识：先查别名表，再按路径扩展名，最后回落 text。 */
export function normalizeCardContentLanguage(value: unknown, path: string): CardContentLanguage {
  if (typeof value === "string" && value.trim().length > 0) {
    const mapped = LANGUAGE_ALIASES[value.trim().toLowerCase()];
    if (mapped !== undefined) {
      return mapped;
    }
    if ((CARD_CONTENT_LANGUAGES as readonly string[]).includes(value.trim())) {
      return value.trim() as CardContentLanguage;
    }
  }
  return path.length > 0 ? languageFromPath(path) : "text";
}

export interface CardContentFileView {
  path: string;
  language: CardContentLanguage;
  role: CardContentFileRole;
  content: string;
}

export interface CardContentCallStepView {
  step: number;
  file: string;
  function: string;
  note: string;
}

export interface CardContentWorkedExampleView {
  explanation: string;
  files: CardContentFileView[];
  entryFile: string;
  callSequence: CardContentCallStepView[];
  /** 保持字符串（v2 刻意不对象化）：格式由提示词要求「文件 › 函数：」前缀。 */
  expectedOutput: string;
}

export interface PitfallDebugSnapshot {
  title: string;
  cause: string;
  fix: string;
}

export interface CardContentSnapshot {
  id: string;
  planNodeId: string;
  version: number;
  status: string;
  schemaVersion: string;
  foundation: string;
  workedExample: CardContentWorkedExampleView;
  pitfallsDebug: PitfallDebugSnapshot[];
  sourceRefs: Array<Record<string, unknown>>;
  createdAt: Date;
  updatedAt: Date;
  generatedAt: Date | null;
}

export interface CardContentQueryRepository {
  findOwnedReadyContent(ownerId: string, cardContentId: string): Promise<CardContentSnapshot | null>;
}

export type CardContentQueryErrorCode = "CARD_CONTENT_NOT_FOUND";

export class CardContentQueryServiceError extends Error {
  constructor(public readonly code: CardContentQueryErrorCode) {
    super(code);
    this.name = "CardContentQueryServiceError";
  }
}
