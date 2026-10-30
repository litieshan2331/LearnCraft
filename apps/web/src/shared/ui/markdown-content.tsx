/**
 * 安全渲染带围栏代码块的 Markdown 文本。
 * 调用顺序：MarkdownContent 规范化换行并拆分代码围栏 → PlainText 保留段落换行 → CodeBlock 展示语言和源码。
 */

/** 将模型和题目内容中的围栏代码按统一的深色代码块样式展示；内容始终作为 React 文本节点渲染。 */
export function MarkdownContent({
  content,
  className,
}: Readonly<{ content: string; className?: string }>) {
  const segments = normalizeMarkdown(content).split(/```([a-zA-Z0-9_+#.-]*)\n([\s\S]*?)```/g);

  return (
    <div className={className}>
      {segments.map((segment, index) => {
        if (index % 3 === 0) return <PlainText content={segment} key={`text-${index}`} />;
        if (index % 3 === 1) {
          return <CodeBlock content={segments[index + 1] ?? ""} key={`code-${index}`} language={segment || null} />;
        }
        return null;
      })}
    </div>
  );
}

/** 兼容模型偶尔把完整 Markdown 换行转义为字面量反斜杠序列的情况。 */
function normalizeMarkdown(content: string): string {
  if (content.includes("\n") || !content.includes("\\n") || !content.includes("```")) return content;

  let normalized = "";
  for (let index = 0; index < content.length;) {
    if (content.startsWith("\\r\\n", index)) {
      normalized += "\n";
      index += 4;
      continue;
    }
    if (content.startsWith("\\n", index)) {
      normalized += "\n";
      index += 2;
      continue;
    }
    if (content.startsWith("\\\\", index)) {
      normalized += "\\";
      index += 2;
      continue;
    }
    normalized += content[index];
    index += 1;
  }
  return normalized;
}

/** 用换行保留纯文本段落的原始结构。 */
function PlainText({ content }: Readonly<{ content: string }>) {
  const trimmedContent = content.trim();
  if (!trimmedContent) return null;

  return (
    <p>
      {trimmedContent.split("\n").map((line, index) => (
        <span key={`${index}-${line}`}>
          {index > 0 ? <br /> : null}
          {line}
        </span>
      ))}
    </p>
  );
}

/** 展示语言标签与可横向滚动的源码；窄屏下代码不会撑宽对话面板。 */
function CodeBlock({ content, language }: Readonly<{ content: string; language: string | null }>) {
  return (
    <div className="max-w-full overflow-hidden rounded-[1.25rem] border border-[#17353a] bg-[#17353a] text-[#eef7f6]">
      {language ? <p className="border-b border-white/15 px-3 py-1.5 font-mono text-xs lowercase text-[#b7cfcd]">{language}</p> : null}
      <pre className="max-w-full overflow-x-auto p-4 font-mono text-sm leading-6"><code>{content}</code></pre>
    </div>
  );
}
