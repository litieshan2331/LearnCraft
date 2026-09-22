/**
 * 结构化纯文本展示（保留换行，只做四种轻量排版）。
 *
 * 组件与函数：
 * - ContentText：解析并渲染 foundation、worked_example.explanation、expected_output 等长文本；
 * - ContentBlock：按块类型分发（段落 / 小标题 / 列表）；
 * - ContentList：渲染列表，嵌套的子列表递归渲染；
 * - InlineText：渲染行内片段，把 **加粗** 变成 <strong>。
 *
 * 排版约定（空行分段、行首 `- `/`1. `/`1、` 列表、行首 `## ` 小标题、行内 `**加粗**`）
 * 见 ../content-text-blocks.ts；文本一律以 React 文本节点渲染，不注入 HTML。
 * 视觉层级：小标题 = 加大字号 + semibold + primary 竖线；加粗 = font-bold + 前景色；
 * 有序列表统一渲染成「1、2、3、」编号（样式见 globals.css 的 .content-ordered-list）。
 */

import {
  parseContentText,
  parseContentTextSegments,
  type ContentTextBlock,
  type ContentTextListBlock,
} from "../content-text-blocks";

export function ContentText({
  value,
  className,
}: Readonly<{ value: string; className?: string }>) {
  const blocks = parseContentText(value);
  return (
    <div className={"space-y-4 " + (className ?? "")}>
      {blocks.map((block, index) => (
        <ContentBlock block={block} key={String(index)} />
      ))}
    </div>
  );
}

/** 单个块：段落保留段内换行，小标题只做强调，列表交给 ContentList。 */
function ContentBlock({ block }: Readonly<{ block: ContentTextBlock }>) {
  if (block.kind === "paragraph") {
    return (
      <p className="whitespace-pre-line">
        <InlineText value={block.text} />
      </p>
    );
  }
  if (block.kind === "heading") {
    return (
      <p className="-ml-2 border-l-2 border-l-primary/45 pl-2 text-base font-semibold text-foreground">
        <InlineText value={block.text} />
      </p>
    );
  }
  return <ContentList list={block} />;
}

/** 列表块；nested 用于给子列表补一点上间距。 */
function ContentList({ list, nested = false }: Readonly<{ list: ContentTextListBlock; nested?: boolean }>) {
  const listClassName = (nested ? "mt-1 " : "")
    + "space-y-1 pl-5 "
    + (list.ordered ? "content-ordered-list list-decimal" : "list-disc");
  const items = list.items.map((item, index) => (
    <li key={String(index)}>
      <span className="whitespace-pre-line">
        <InlineText value={item.text} />
      </span>
      {item.children.map((child, childIndex) => (
        <ContentList key={String(childIndex)} list={child} nested />
      ))}
    </li>
  ));
  return list.ordered
    ? <ol className={listClassName} start={list.start}>{items}</ol>
    : <ul className={listClassName}>{items}</ul>;
}

/**
 * 行内片段：加粗片段渲染成 <strong>，普通片段直接输出文本（不额外包标签，
 * 保证没有加粗标记的内容与改造前的 DOM 完全一致）；换行仍由上层 whitespace-pre-line 保留。
 */
function InlineText({ value }: Readonly<{ value: string }>) {
  return (
    <>
      {parseContentTextSegments(value).map((segment, index) => (
        segment.bold
          ? <strong className="font-bold text-foreground" key={String(index)}>{segment.text}</strong>
          : segment.text
      ))}
    </>
  );
}
