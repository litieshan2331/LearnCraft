/**
 * 代码高亮适配器（Shiki，服务端渲染）。
 *
 * 职责：把示例文件内容渲染为**已转义**的内联 HTML（不含 <pre> 包裹，容器样式由调用方决定）。
 * 设计取舍：
 * - 只注册产品确定支持的语言（与 domain/content-query.ts 的白名单一致），不打包全量语法；
 * - 不在白名单内的语言（`text` 等）直接返回转义后的纯文本，不报错、不上色；
 * - 高亮实例进程内复用（Shiki 初始化较重）；初始化或渲染失败时回落纯文本，绝不因此让页面报错。
 *
 * 说明：示例内容由客户端组件（plan-node-view → card-content-view）展示，浏览器不加载高亮引擎，
 * 因此高亮在服务端、由读取接口（GET /api/v1/card-contents/{id}）预渲染成 files[].html 随响应返回，
 * 再由客户端组件切换显示。本模块是无状态渲染适配器，不含配置与生命周期；
 * 把 Shiki 收敛在这一个文件里，便于以后替换高亮实现。
 *
 * 导出：
 * - SHIKI_THEME：当前使用的主题标识（与内容页深色代码块协调，调整只改这一处）。
 * - escapeHtml：HTML 转义（纯文本回落路径复用）。
 * - highlightCardContentCode：按语言高亮并返回内联 HTML。
 * - highlightWorkedExampleFiles：逐文件高亮，返回 path → HTML 映射（每个输入文件都有一条）。
 */

import { createHighlighter, type Highlighter } from "shiki";

import type { CardContentFileView, CardContentLanguage } from "../domain/content-query";

/** 与内容页深色代码块（#17353a 底 + 浅色字）协调的深色主题；改主题只改这一行。 */
export const SHIKI_THEME = "github-dark";

/** 实际注册到 Shiki 的语法 id（只有这里列出的语言会被打包）。 */
const SHIKI_LANGUAGE_IDS = [
  "javascript",
  "jsx",
  "typescript",
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
] as const;

type ShikiLanguageId = (typeof SHIKI_LANGUAGE_IDS)[number];

/** 白名单语言 → Shiki 语法 id；未列出的语言（如 text）不高亮。 */
const SHIKI_LANGUAGES: Readonly<Partial<Record<CardContentLanguage, ShikiLanguageId>>> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  python: "python",
  java: "java",
  go: "go",
  c: "c",
  cpp: "cpp",
  csharp: "csharp",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
};

let highlighterPromise: Promise<Highlighter> | null = null;

/** 进程内复用高亮实例；初始化失败时清空缓存以便下次重试。 */
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [SHIKI_THEME],
    langs: [...SHIKI_LANGUAGE_IDS],
  }).catch((error: unknown) => {
    highlighterPromise = null;
    throw error;
  });
  return highlighterPromise;
}

/** HTML 转义：纯文本回落路径与失败兜底共用。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 按语言高亮示例代码，返回**已转义**的内联 HTML（Shiki 只产生 span 与转义后的文本）。
 * 语言不在白名单、或高亮过程出错时，回落为转义后的纯文本。
 */
export async function highlightCardContentCode(
  code: string,
  language: CardContentLanguage,
): Promise<string> {
  const shikiLanguage = SHIKI_LANGUAGES[language];
  if (shikiLanguage === undefined) {
    return escapeHtml(code);
  }
  try {
    const highlighter = await getHighlighter();
    return highlighter.codeToHtml(code, {
      lang: shikiLanguage,
      theme: SHIKI_THEME,
      structure: "inline",
    });
  } catch {
    return escapeHtml(code);
  }
}

/**
 * 逐个示例文件高亮，返回 path → 内联 HTML 的映射。
 * 读取接口用它把「原始代码 + 预渲染 HTML」一起返回；每个输入文件都保证有一条记录
 * （语言不在白名单时同样会得到转义后的纯文本 HTML）。
 */
export async function highlightWorkedExampleFiles(
  files: readonly CardContentFileView[],
): Promise<ReadonlyMap<string, string>> {
  const rendered = await Promise.all(
    files.map(async (file) => [file.path, await highlightCardContentCode(file.content, file.language)] as const),
  );
  return new Map(rendered);
}
