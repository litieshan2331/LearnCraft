/**
 * 代码高亮适配器的单元测试。
 *
 * 重点固化：\`text\` 等白名单外语言回落为**已转义**的纯文本、HTML 转义正确、
 * 白名单内语言确实经 Shiki 渲染出 span（证明依赖在该运行时可用）、
 * 逐文件高亮对每个输入路径都给出一条映射（读取接口据此填充 files[].html）。
 */
import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  highlightCardContentCode,
  highlightWorkedExampleFiles,
} from "../../src/modules/content/infrastructure/code-highlighter";

describe("escapeHtml", () => {
  it("转义 & < >", () => {
    expect(escapeHtml('<script>a & b</script>')).toBe("&lt;script&gt;a &amp; b&lt;/script&gt;");
  });
});

describe("highlightCardContentCode", () => {
  it("白名单外语言（text）回落为纯文本且被转义", async () => {
    const html = await highlightCardContentCode('const a = "<x>";', "text");

    expect(html).toBe('const a = "&lt;x&gt;";');
    expect(html).not.toContain("<span");
  });

  it("白名单内语言经 Shiki 渲染为带 span 的 HTML，且内容被转义", async () => {
    const html = await highlightCardContentCode('const a = "<x>";', "ts");

    expect(html).toContain("<span");
    expect(html).not.toContain("<x>");
  }, 30_000);
});

describe("highlightWorkedExampleFiles", () => {
  it("每个输入文件都返回一条 path → HTML 映射，白名单外语言为转义纯文本", async () => {
    const html = await highlightWorkedExampleFiles([
      { path: "src/main.ts", language: "ts", role: "entry", content: "const a = 1;" },
      { path: "README", language: "text", role: "other", content: "<b>a</b>" },
    ]);

    expect([...html.keys()]).toEqual(["src/main.ts", "README"]);
    expect(html.get("src/main.ts")).toContain("<span");
    expect(html.get("README")).toBe("&lt;b&gt;a&lt;/b&gt;");
  }, 30_000);
});
