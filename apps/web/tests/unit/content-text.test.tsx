/**
 * 结构化纯文本组件的渲染测试。
 *
 * 重点固化：段落、列表、嵌套列表与行内加粗渲染成对应标签，文本内容始终被转义（不注入 HTML）。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContentText } from "../../src/modules/content/presentation/components/content-text";

describe("ContentText", () => {
  it("渲染段落、无序列表与嵌套列表", () => {
    const html = renderToStaticMarkup(
      <ContentText value={"结论先行。\n\n- 甲\n  - 甲一\n- 乙"} />,
    );

    expect(html).toContain("<p class=\"whitespace-pre-line\">结论先行。</p>");
    expect(html.match(/<ul/g)).toHaveLength(2);
    expect(html).toContain("甲一");
  });

  it("有序列表带起始序号并渲染成 1、2、3、样式，小标题做层级强调", () => {
    const html = renderToStaticMarkup(<ContentText value={"## 小节\n3. 丙"} />);

    expect(html).toContain("<ol");
    expect(html).toContain("start=\"3\"");
    expect(html).toContain("content-ordered-list");
    expect(html).toContain("text-base font-semibold");
  });

  it("文本不注入 HTML", () => {
    const html = renderToStaticMarkup(<ContentText value={"<b>粗体</b>"} />);

    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("行内 **加粗** 渲染成 strong，加粗内容同样被转义", () => {
    const html = renderToStaticMarkup(
      <ContentText value={"**Promise.all** 会整批失败，**<i>x</i>**。"} />,
    );

    expect(html).toContain("<strong class=\"font-bold text-foreground\">Promise.all</strong>");
    expect(html).toContain("&lt;i&gt;");
    expect(html).not.toContain("<i>");
  });
});
