/**
 * 节点内容纯文本的轻量排版解析（纯函数，便于单测）。
 *
 * 职责：把模型返回的长文本字符串解析成结构化块与行内片段，供 content-text.tsx 渲染。
 * 渲染层只认四种约定，其余 Markdown 一律当普通文本（提示词里也只允许这四种约定）：
 * - 空行分段；
 * - 行首 `- `（`* `、`+ ` 同样接受）列点、`1. ` 或 `1、` 有序编号；行首缩进更深表示下一层
 *   （2 个空格或 4 个空格都可以，制表符按 4 个空格计）；
 * - 行首 `## ` 或 `### ` 写小节标题；
 * - 行内 `**加粗**`（成对出现且不跨行）强调关键术语或结论词。
 *
 * 段内的单个换行保留在段落文本里（由 whitespace-pre-line 呈现），因此历史内容（只有换行、没有标记）
 * 的观感与改造前一致。
 *
 * 导出：
 * - ContentTextSegment：行内片段（文本 + 是否加粗）。
 * - ContentTextListItem：列表项（文本 + 嵌套的子列表）。
 * - ContentTextListBlock：一个列表块（有序/无序 + 起始序号 + 列表项）。
 * - ContentTextBlock：段落 / 小标题 / 列表三种块。
 * - parseContentTextSegments：把一段文本切分为行内片段（识别 **加粗**）。
 * - parseContentText：把字符串解析为块序列。
 */

export interface ContentTextSegment {
  text: string;
  bold: boolean;
}

export interface ContentTextListItem {
  text: string;
  children: ContentTextListBlock[];
}

export interface ContentTextListBlock {
  kind: "list";
  ordered: boolean;
  /** 有序列表的起始序号；无序列表固定为 1。 */
  start: number;
  items: ContentTextListItem[];
}

export type ContentTextBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | ContentTextListBlock;

/** 小节标题：两个或三个井号加空格；单个井号按普通文本处理。 */
const HEADING_PATTERN = /^(#{2,3})[ \t]+(.+?)[ \t]*$/;

/** 无序列表项：行首缩进 + 标记（-、*、+）+ 至少一个空格 + 文本。 */
const BULLET_ITEM_PATTERN = /^([ \t]*)([-*+])[ \t]+(.*)$/;

/** 有序列表项：行首缩进 + 数字 + 「.」或「、」+ 可选空格 + 文本（中文写法「1、甲」不带空格）。 */
const ORDERED_ITEM_PATTERN = /^([ \t]*)(\d+)[.、][ \t]*(.*)$/;

/** 行内加粗：成对的 **，内容非空、不含 * 且不跨行；不配对的 ** 原样保留。 */
const BOLD_PATTERN = /\*\*([^*\n]+)\*\*/g;

interface ParsedItem {
  indent: number;
  ordered: boolean;
  number: number;
  text: string;
}

/** 行首缩进宽度：空格按 1 计，制表符按 4 计。 */
function indentWidth(prefix: string): number {
  let width = 0;
  for (const character of prefix) {
    width += character === "\t" ? 4 : 1;
  }
  return width;
}

/**
 * 把一段文本切分为行内片段：**加粗** 之间的部分标为 bold，其余为普通文本。
 * 不配对的 **、空的 **** 与跨行的 ** 都不识别，保持原样。
 */
export function parseContentTextSegments(value: string): ContentTextSegment[] {
  const segments: ContentTextSegment[] = [];
  let cursor = 0;
  for (const match of value.matchAll(BOLD_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ text: value.slice(cursor, start), bold: false });
    }
    segments.push({ text: match[1] ?? "", bold: true });
    cursor = start + match[0].length;
  }
  if (cursor < value.length) {
    segments.push({ text: value.slice(cursor), bold: false });
  }
  return segments;
}

/** 把行序列表项按缩进组装成列表块；同层标记类型变化时拆成多个列表。 */
function buildLists(items: ParsedItem[]): ContentTextListBlock[] {
  const lists: ContentTextListBlock[] = [];
  let cursor = 0;
  while (cursor < items.length) {
    const built = buildList(items, cursor, items[cursor]?.indent ?? 0);
    lists.push(built.list);
    cursor = built.next;
  }
  return lists;
}

/**
 * 从 start 开始收集同一层级的列表项；缩进更深的行收进上一项的 children（递归），
 * 回到更浅的层级或遇到同层不同类型的标记就结束，把游标交还给调用方。
 */
function buildList(
  items: ParsedItem[],
  start: number,
  indent: number,
): { list: ContentTextListBlock; next: number } {
  const first = items[start];
  const ordered = first?.ordered ?? false;
  const list: ContentTextListBlock = {
    kind: "list",
    ordered,
    start: ordered ? (first?.number ?? 1) : 1,
    items: [],
  };
  let cursor = start;
  while (cursor < items.length) {
    const item = items[cursor];
    if (item === undefined || item.indent < indent) {
      break;
    }
    if (item.indent > indent) {
      const nested = buildList(items, cursor, item.indent);
      list.items[list.items.length - 1]?.children.push(nested.list);
      cursor = nested.next;
      continue;
    }
    if (item.ordered !== ordered) {
      break;
    }
    list.items.push({ text: item.text, children: [] });
    cursor += 1;
  }
  return { list, next: cursor };
}

/** 把长文本解析为块序列：空行分段、标记行成列表、## 成小标题，其余按段落累积。 */
export function parseContentText(value: string): ContentTextBlock[] {
  const blocks: ContentTextBlock[] = [];
  let paragraph: string[] = [];
  let items: ParsedItem[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (items.length > 0) {
      blocks.push(...buildLists(items));
      items = [];
    }
  };

  for (const line of value.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", text: heading[2] ?? "" });
      continue;
    }

    const bullet = BULLET_ITEM_PATTERN.exec(line);
    const orderedItem = bullet === null ? ORDERED_ITEM_PATTERN.exec(line) : null;
    const item = bullet ?? orderedItem;
    if (item !== null) {
      flushParagraph();
      items.push({
        indent: indentWidth(item[1] ?? ""),
        ordered: orderedItem !== null,
        number: orderedItem !== null ? Number.parseInt(orderedItem[2] ?? "1", 10) : 1,
        text: item[3] ?? "",
      });
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}
