/**
 * 纯文本内容展示（保留换行，不做 Markdown 解析）。
 *
 * 组件与函数：
 * - ContentText：把带换行的字符串按行渲染，行间用 <br /> 连接。
 */

export function ContentText({ value, className }: Readonly<{ value: string; className?: string }>) {
  return (
    <p className={className}>
      {value.split("\n").map((line, index) => (
        <span key={String(index) + "-" + line}>{index > 0 ? <br /> : null}{line}</span>
      ))}
    </p>
  );
}
