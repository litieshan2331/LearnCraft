/**
 * 节点内容轻量排版解析的单元测试。
 *
 * 重点固化：空行分段且段内换行原样保留、`- ` 成无序列表、`1. ` 与 `1、` 保留起始序号、
 * 缩进（2 或 4 个空格）成嵌套列表、同层标记类型变化拆成两个列表、`## ` 才是小标题、
 * 没有标记的历史内容仍解析成单一整段；`**加粗**` 识别为行内片段，不配对或跨行的 `**` 原样保留。
 */
import { describe, expect, it } from "vitest";

import {
  parseContentText,
  parseContentTextSegments,
} from "../../src/modules/content/presentation/content-text-blocks";

describe("parseContentText", () => {
  it("空行分段，段内换行原样保留", () => {
    expect(parseContentText("第一行\n第二行\n\n第二段")).toEqual([
      { kind: "paragraph", text: "第一行\n第二行" },
      { kind: "paragraph", text: "第二段" },
    ]);
  });

  it("- 标记生成无序列表，连续行归入同一个列表", () => {
    expect(parseContentText("- 甲\n- 乙\n\n后面的段落")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          { text: "甲", children: [] },
          { text: "乙", children: [] },
        ],
      },
      { kind: "paragraph", text: "后面的段落" },
    ]);
  });

  it("有序列表保留起始序号", () => {
    const blocks = parseContentText("3. 丙\n4. 丁");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 3,
        items: [
          { text: "丙", children: [] },
          { text: "丁", children: [] },
        ],
      },
    ]);
  });

  it("中文顿号编号（1、）同样识别为有序列表", () => {
    expect(parseContentText("1、甲\n2、乙")).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [
          { text: "甲", children: [] },
          { text: "乙", children: [] },
        ],
      },
    ]);
  });

  it("缩进 2 个或 4 个空格都解析成下一层", () => {
    const twoSpaces = parseContentText("- 甲\n  - 甲一\n- 乙");
    const fourSpaces = parseContentText("- 甲\n    - 甲一\n- 乙");
    const expected = [
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          {
            text: "甲",
            children: [
              {
                kind: "list",
                ordered: false,
                start: 1,
                items: [{ text: "甲一", children: [] }],
              },
            ],
          },
          { text: "乙", children: [] },
        ],
      },
    ];
    expect(twoSpaces).toEqual(expected);
    expect(fourSpaces).toEqual(expected);
  });

  it("同层标记类型变化时拆成两个列表", () => {
    const blocks = parseContentText("- 甲\n1. 乙");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: false });
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: true, start: 1 });
  });

  it("## 与 ### 是小节标题，单个井号不是", () => {
    expect(parseContentText("## 小节\n### 更小的小节")).toEqual([
      { kind: "heading", text: "小节" },
      { kind: "heading", text: "更小的小节" },
    ]);
    expect(parseContentText("# 不是标题")).toEqual([{ kind: "paragraph", text: "# 不是标题" }]);
  });

  it("CRLF 与制表符缩进同样识别", () => {
    expect(parseContentText("- 甲\r\n\t- 甲一\r\n")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          {
            text: "甲",
            children: [
              { kind: "list", ordered: false, start: 1, items: [{ text: "甲一", children: [] }] },
            ],
          },
        ],
      },
    ]);
  });

  it("空字符串与纯空白返回空块", () => {
    expect(parseContentText("")).toEqual([]);
    expect(parseContentText("  \n\n ")).toEqual([]);
  });
});

describe("parseContentTextSegments", () => {
  it("识别成对的 **加粗**，并保留前后普通文本", () => {
    expect(parseContentTextSegments("先看 **数据形状**：一条待办。")).toEqual([
      { text: "先看 ", bold: false },
      { text: "数据形状", bold: true },
      { text: "：一条待办。", bold: false },
    ]);
  });

  it("一行里可以有多段加粗", () => {
    expect(parseContentTextSegments("**甲**和**乙**")).toEqual([
      { text: "甲", bold: true },
      { text: "和", bold: false },
      { text: "乙", bold: true },
    ]);
  });

  it("不配对、空内容与跨行的 ** 原样保留", () => {
    expect(parseContentTextSegments("只有 ** 一个")).toEqual([
      { text: "只有 ** 一个", bold: false },
    ]);
    expect(parseContentTextSegments("****")).toEqual([{ text: "****", bold: false }]);
    expect(parseContentTextSegments("**甲\n乙**")).toEqual([
      { text: "**甲\n乙**", bold: false },
    ]);
  });

  it("没有标记时仍返回一个普通片段", () => {
    expect(parseContentTextSegments("普通文本")).toEqual([{ text: "普通文本", bold: false }]);
  });
});
