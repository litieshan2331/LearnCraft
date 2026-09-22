/**
 * 节点知识内容公开响应映射器的单元测试。
 */
import { describe, expect, it } from "vitest";

import type { CardContentSnapshot } from "../../src/modules/content/domain/content-query";
import { presentCardContent } from "../../src/modules/content/interfaces/card-content-presenter";

const snapshot: CardContentSnapshot = {
  id: "6d1f3f6e-3f2e-4a4e-9a2f-2b9d4c1f0a11",
  planNodeId: "a3da445d-3c9f-43e4-95b6-8b6a2e746a6f",
  version: 1,
  status: "ready",
  schemaVersion: "card_content.v2",
  foundation: "函数把一段逻辑命名后复用。",
  workedExample: {
    explanation: "先定义再调用。",
    files: [
      { path: "src/main.ts", language: "ts", role: "entry", content: "add(1, 2);" },
      { path: "src/add.ts", language: "ts", role: "module", content: "export const add = (a: number, b: number) => a + b;" },
    ],
    entryFile: "src/main.ts",
    callSequence: [{ step: 1, file: "src/add.ts", function: "add", note: "求和" }],
    expectedOutput: "src/main.ts › 输出：3",
  },
  pitfallsDebug: [{ title: "忘记返回", cause: "没有 return。", fix: "补上 return。" }],
  sourceRefs: [{ title: "MDN", url: "https://example.com" }],
  createdAt: new Date("2026-09-22T00:00:00.000Z"),
  updatedAt: new Date("2026-09-22T00:00:00.000Z"),
  generatedAt: null,
};

describe("presentCardContent", () => {
  it("示例文件带出服务端预渲染的 html，其余字段保持 snake_case 与字符串 expected_output", () => {
    const presented = presentCardContent(
      snapshot,
      new Map([["src/main.ts", "<span>add</span>(1, 2);"]]),
    );

    expect(Object.keys(presented.worked_example.files[0] ?? {}).sort()).toEqual([
      "content", "html", "language", "path", "role",
    ]);
    expect(presented.worked_example.files[0]).toMatchObject({
      path: "src/main.ts",
      language: "ts",
      role: "entry",
      content: "add(1, 2);",
      html: "<span>add</span>(1, 2);",
    });
    expect(presented.worked_example.entry_file).toBe("src/main.ts");
    expect(presented.worked_example.call_sequence).toEqual([
      { step: 1, file: "src/add.ts", function: "add", note: "求和" },
    ]);
    expect(typeof presented.worked_example.expected_output).toBe("string");
    expect(presented.worked_example.expected_output).toBe("src/main.ts › 输出：3");
    expect(presented.schema_version).toBe("card_content.v2");
    expect(presented.created_at).toBe("2026-09-22T00:00:00.000Z");
    expect(presented.generated_at).toBeNull();
  });

  it("预渲染映射缺少某个路径时回落空字符串（读取接口保证每个文件都有 html）", () => {
    const presented = presentCardContent(snapshot, new Map());

    expect(presented.worked_example.files.map((file) => file.html)).toEqual(["", ""]);
  });
});
