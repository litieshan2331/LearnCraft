/**
 * worked_example 读侧归一化的单元测试。
 *
 * 重点固化：
 * - v2（files + entry_file + 对象化 call_sequence）直接映射，语言别名归一化；
 * - v1 历史内容按 \`// 路径\` 注释拆分成多文件（这正是 v1 的书写约定），语言按扩展名推断，
 *   字符串数组的调用顺序包成对象并挂到入口文件；
 * - 无法使用时返回 null（调用方据此判定内容不可读）。
 */
import { describe, expect, it } from "vitest";

import {
  legacyPathFromLine,
  normalizeWorkedExample,
  splitLegacyCodeIntoFiles,
} from "../../src/modules/content/infrastructure/card-content-worked-example-normalizer";

describe("legacyPathFromLine", () => {
  it("识别带路径或已知扩展名的注释行", () => {
    expect(legacyPathFromLine("// src/types/todo.ts")).toBe("src/types/todo.ts");
    expect(legacyPathFromLine("// index.html")).toBe("index.html");
    expect(legacyPathFromLine("   //   app/main.py  ")).toBe("app/main.py");
  });

  it("不把普通注释或说明文字当成路径", () => {
    expect(legacyPathFromLine("// 这里是说明文字")).toBeNull();
    expect(legacyPathFromLine("// TODO: 处理边界")).toBeNull();
    expect(legacyPathFromLine("// 1. 先准备输入")).toBeNull();
    expect(legacyPathFromLine("const a = 1; // src/a.ts")).toBeNull();
  });
});

describe("splitLegacyCodeIntoFiles", () => {
  it("按 \`// 路径\` 标记拆成多个文件并推断语言", () => {
    const code = [
      "// src/types/todo.ts",
      "export type Todo = { id: number };",
      "",
      "// src/api/client.ts",
      "export async function request() {}",
    ].join("\n");

    const files = splitLegacyCodeIntoFiles(code);

    expect(files.map((file) => file.path)).toEqual(["src/types/todo.ts", "src/api/client.ts"]);
    expect(files.map((file) => file.language)).toEqual(["ts", "ts"]);
    expect(files.map((file) => file.role)).toEqual(["entry", "module"]);
    expect(files[0]?.content).toBe("export type Todo = { id: number };");
    expect(files[1]?.content).toBe("export async function request() {}");
  });

  it("没有路径标记时整段作为单个文件（语言回落 text）", () => {
    const files = splitLegacyCodeIntoFiles("print(1)\n");

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "main", language: "text", role: "entry" });
    expect(files[0]?.content).toBe("print(1)");
  });

  it("第一个标记之前的正文被丢弃", () => {
    const code = ["这是一段开场说明。", "// src/a.ts", "const a = 1;"].join("\n");

    const files = splitLegacyCodeIntoFiles(code);

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/a.ts");
  });
});

describe("normalizeWorkedExample", () => {
  it("v2 直接映射，并归一化语言别名与缺省 role", () => {
    const worked = normalizeWorkedExample({
      schemaVersion: "card_content.v2",
      raw: {
        explanation: "说明",
        files: [
          { path: "src/a.ts", language: "TypeScript", content: "a" },
          { path: "b.py", language: "py", role: "entry", content: "b" },
        ],
        entry_file: "b.py",
        call_sequence: [{ step: 1, file: "b.py", function: "b", note: "调用 b" }],
        expected_output: "b.py › b：输出",
      },
    });

    expect(worked).toEqual({
      explanation: "说明",
      files: [
        { path: "src/a.ts", language: "ts", role: "module", content: "a" },
        { path: "b.py", language: "python", role: "entry", content: "b" },
      ],
      entryFile: "b.py",
      callSequence: [{ step: 1, file: "b.py", function: "b", note: "调用 b" }],
      expectedOutput: "b.py › b：输出",
    });
  });

  it("v1 历史内容：\`code\` 拆成多文件，字符串调用顺序挂到入口文件", () => {
    const worked = normalizeWorkedExample({
      schemaVersion: "card_content.v1",
      raw: {
        explanation: "说明",
        code: "// src/types/todo.ts\nexport type Todo = { id: number };\n// src/panel.tsx\nconst Panel = 1;",
        call_sequence: ["先定义类型", "再渲染面板"],
        expected_output: "页面显示面板",
      },
    });

    expect(worked?.files.map((file) => file.path)).toEqual(["src/types/todo.ts", "src/panel.tsx"]);
    expect(worked?.files.map((file) => file.language)).toEqual(["ts", "tsx"]);
    expect(worked?.entryFile).toBe("src/types/todo.ts");
    expect(worked?.callSequence).toEqual([
      { step: 1, file: "src/types/todo.ts", function: "", note: "先定义类型" },
      { step: 2, file: "src/types/todo.ts", function: "", note: "再渲染面板" },
    ]);
    expect(worked?.expectedOutput).toBe("页面显示面板");
  });

  it("既没有 files 也没有 code 时返回 null", () => {
    expect(normalizeWorkedExample({ schemaVersion: "card_content.v2", raw: {} })).toBeNull();
    expect(normalizeWorkedExample({ schemaVersion: "card_content.v2", raw: { explanation: "只有说明" } })).toBeNull();
    expect(normalizeWorkedExample({ schemaVersion: "card_content.v2", raw: null })).toBeNull();
    expect(normalizeWorkedExample({ schemaVersion: "card_content.v1", raw: { code: "   " } })).toBeNull();
  });
});
