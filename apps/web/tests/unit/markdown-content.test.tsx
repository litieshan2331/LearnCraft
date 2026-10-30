/**
 * 共享 Markdown 内容组件测试。
 * 调用顺序：传入题目或助手文本 → 服务端静态渲染 → 验证代码围栏、语言标签和源码转义。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownContent } from "../../src/shared/ui/markdown-content";

describe("MarkdownContent", () => {
  it("以统一代码块展示围栏代码并安全转义源码", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent content={'答案如下：\n```css\n.box { width: 350px; content: "<x>"; }\n```'} />,
    );

    expect(html).toContain("答案如下：");
    expect(html).toContain(">css</p>");
    expect(html).toContain("<pre");
    expect(html).toContain(".box { width: 350px; content: &quot;&lt;x&gt;&quot;; }");
    expect(html).not.toContain("```css");
  });

  it("兼容被转义的围栏换行", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent content={'代码：\\n```ts\\nconst answer = 42;\\n```'} />,
    );

    expect(html).toContain(">ts</p>");
    expect(html).toContain("const answer = 42;");
    expect(html).not.toContain("\\n```");
  });
});
