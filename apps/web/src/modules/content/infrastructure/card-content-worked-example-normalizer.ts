/**
 * 节点知识内容 `worked_example` 的读侧归一化。
 *
 * 职责：把库里两种形状收敛成同一个读侧视图模型（`CardContentWorkedExampleView`）：
 * - **v2（card_content.v2）**：`files[]` + `entry_file` + 对象化 `call_sequence`，直接映射；
 * - **v1（card_content.v1，历史数据）**：`code`（多个文件挤在一段文本里）+ 字符串数组
 *   `call_sequence`。这里按 `// 路径` 注释行**启发式拆分**成多个文件（这正是 v1 的书写约定），
 *   语言按扩展名推断；拆分不出路径时降级为单个文件。
 *
 * 之所以要把兼容放在读侧：v1 内容已确认**不重新生成**，会长期留在库里，因此这条分支是长期存在的能力，
 * 而不是一次性迁移补丁。归一化只做形状收敛与兜底，不放宽任何展示约束。
 *
 * 导出：
 * - normalizeWorkedExample：把库里的 worked_example 归一化为读侧视图模型；不可用时返回 null。
 * - splitLegacyCodeIntoFiles：v1 的 `// 路径` 拆分（供本模块与测试复用）。
 * - legacyPathFromLine：判断一行注释是否是文件路径标记。
 */

import {
  CARD_CONTENT_LIMITS,
  languageFromPath,
  normalizeCardContentLanguage,
  type CardContentCallStepView,
  type CardContentFileRole,
  type CardContentFileView,
  type CardContentWorkedExampleView,
} from "../domain/content-query";

/** v1 拆分后的兜底文件路径（拆不出路径时使用；无扩展名 → 语言 text，不高亮）。 */
const LEGACY_FALLBACK_PATH = "main";

/** 已知代码/文本扩展名：只有带这些扩展名（或含 /）的注释才被当作文件路径标记。 */
const PATH_LIKE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "go", "rs", "c", "h", "cpp", "hpp",
  "cs", "php", "rb", "kt", "swift", "sql", "html", "css", "scss", "json", "yaml", "yml",
  "toml", "md", "sh", "txt", "vue", "svelte",
]);

/** 判断一行注释是否是文件路径标记（`// src/types/todo.ts`）。 */
export function legacyPathFromLine(line: string): string | null {
  const match = /^\s*\/\/\s*([A-Za-z0-9_@][A-Za-z0-9_@./-]*)\s*$/.exec(line);
  if (match === null) {
    return null;
  }
  const candidate = match[1]!.trim();
  if (candidate.length === 0 || candidate.length > 200) {
    return null;
  }
  const extensionMatch = /\.([A-Za-z0-9]+)$/.exec(candidate);
  const looksLikePath = candidate.includes("/")
    || (extensionMatch !== null && PATH_LIKE_EXTENSIONS.has(extensionMatch[1]!.toLowerCase()));
  return looksLikePath ? candidate : null;
}

/**
 * 把 v1 的单段代码按 `// 路径` 标记拆成文件。
 * 第一个标记之前的正文（通常是标题或说明）会被丢弃；拆不出标记时整段作为单个文件。
 */
export function splitLegacyCodeIntoFiles(code: string): CardContentFileView[] {
  const lines = code.split(/\r?\n/);
  const files: CardContentFileView[] = [];
  let currentPath: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (currentPath === null) {
      buffer = [];
      return;
    }
    const content = buffer.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    buffer = [];
    if (content.length === 0) {
      return;
    }
    files.push({
      path: currentPath,
      language: languageFromPath(currentPath),
      role: files.length === 0 ? "entry" : "module",
      content: content.slice(0, CARD_CONTENT_LIMITS.maxFileChars),
    });
  };

  for (const line of lines) {
    const candidate = legacyPathFromLine(line);
    if (candidate !== null) {
      flush();
      currentPath = candidate;
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (files.length > 0) {
    return files.slice(0, CARD_CONTENT_LIMITS.maxFiles);
  }

  const content = code.trim();
  if (content.length === 0) {
    return [];
  }
  return [{
    path: LEGACY_FALLBACK_PATH,
    language: languageFromPath(LEGACY_FALLBACK_PATH),
    role: "entry",
    content: content.slice(0, CARD_CONTENT_LIMITS.maxFileChars),
  }];
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** v2：读取 files 数组（字段不合法或空内容直接跳过）。 */
function readV2Files(value: unknown): CardContentFileView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const files: CardContentFileView[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const path = toText(record.path).trim();
    const content = toText(record.content);
    if (path.length === 0 || content.trim().length === 0) {
      continue;
    }
    const role = typeof record.role === "string"
      && (["entry", "types", "module", "ui", "config", "test", "other"] as readonly string[]).includes(record.role)
      ? (record.role as CardContentFileRole)
      : "module";
    files.push({
      path: path.slice(0, 200),
      language: normalizeCardContentLanguage(record.language, path),
      role,
      content: content.slice(0, CARD_CONTENT_LIMITS.maxFileChars),
    });
    if (files.length >= CARD_CONTENT_LIMITS.maxFiles) {
      break;
    }
  }
  return files;
}

/** v2：读取对象化调用顺序（字段不合法直接跳过）。 */
function readV2CallSequence(value: unknown, entryFile: string): CardContentCallStepView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const steps: CardContentCallStepView[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const file = toText(record.file).trim();
    const fn = toText(record.function).trim();
    const note = toText(record.note).trim();
    if (file.length === 0 && fn.length === 0 && note.length === 0) {
      continue;
    }
    steps.push({
      step: steps.length + 1,
      file: (file.length > 0 ? file : entryFile).slice(0, 200),
      function: fn.slice(0, 120),
      note: note.slice(0, 300),
    });
    if (steps.length >= CARD_CONTENT_LIMITS.maxCallSteps) {
      break;
    }
  }
  return steps;
}

/** v1：把字符串数组调用顺序包成对象（无法得知文件/函数，统一挂到入口文件）。 */
function readLegacyCallSequence(value: unknown, entryFile: string): CardContentCallStepView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, CARD_CONTENT_LIMITS.maxCallSteps)
    .map((item, index) => ({
      step: index + 1,
      file: entryFile,
      function: "",
      note: item.trim().slice(0, 300),
    }));
}

/**
 * 把库里的 worked_example 归一化为读侧视图模型。
 * 既没有可用 files 也没有可用 code 时返回 null（调用方据此判定内容不可读）。
 */
export function normalizeWorkedExample(input: {
  raw: unknown;
  /** 库里记录的契约版本；仅用于排障，形状判断以字段为准。 */
  schemaVersion: string;
}): CardContentWorkedExampleView | null {
  const worked = toRecord(input.raw);
  if (Object.keys(worked).length === 0) {
    return null;
  }

  const explanation = toText(worked.explanation).trim();
  const expectedOutput = toText(worked.expected_output).trim();
  const v2Files = readV2Files(worked.files);

  if (v2Files.length > 0) {
    const entryFile = (() => {
      const explicit = toText(worked.entry_file).trim();
      if (explicit.length > 0) {
        return explicit.slice(0, 200);
      }
      const roleEntry = v2Files.find((file) => file.role === "entry");
      return roleEntry?.path ?? v2Files[0]!.path;
    })();
    return {
      explanation,
      files: v2Files,
      entryFile,
      callSequence: readV2CallSequence(worked.call_sequence, entryFile),
      expectedOutput,
    };
  }

  const legacyCode = toText(worked.code);
  if (legacyCode.trim().length === 0) {
    return null;
  }
  const files = splitLegacyCodeIntoFiles(legacyCode);
  if (files.length === 0) {
    return null;
  }
  const entryFile = files[0]!.path;
  return {
    explanation,
    files,
    entryFile,
    callSequence: readLegacyCallSequence(worked.call_sequence, entryFile),
    expectedOutput,
  };
}
