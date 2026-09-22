/**
 * 示例文件目录树构建的单元测试。
 *
 */
import { describe, expect, it } from "vitest";

import {
  ancestorDirectoryKeys,
  buildCardContentFileTree,
} from "../../src/modules/content/presentation/card-content-file-tree";

describe("buildCardContentFileTree", () => {
  it("按路径逐级嵌套，并复用同层目录", () => {
    const tree = buildCardContentFileTree([
      { path: "src/types/todo.ts" },
      { path: "src/features/todos/useTodos.ts" },
      { path: "src/features/todos/TodoPanel.tsx" },
      { path: "index.html" },
    ]);

    expect(tree.map((node) => node.name)).toEqual(["src", "index.html"]);
    const src = tree[0];
    expect(src?.path).toBeNull();
    expect(src?.children.map((node) => node.name)).toEqual(["types", "features"]);

    const features = src?.children[1];
    const todos = features?.children[0];
    expect(todos?.name).toBe("todos");
    expect(todos?.children.map((node) => node.name)).toEqual(["useTodos.ts", "TodoPanel.tsx"]);
    expect(todos?.children[0]?.path).toBe("src/features/todos/useTodos.ts");
  });

  it("保持输入顺序，不做字母排序", () => {
    const tree = buildCardContentFileTree([
      { path: "b.ts" },
      { path: "a.ts" },
    ]);

    expect(tree.map((node) => node.name)).toEqual(["b.ts", "a.ts"]);
  });

  it("忽略空路径与多余分隔符", () => {
    const tree = buildCardContentFileTree([{ path: "" }, { path: "/src//a.ts/" }]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe("src");
    expect(tree[0]?.children[0]?.path).toBe("/src//a.ts/");
  });
});

describe("ancestorDirectoryKeys", () => {
  it("返回由根到叶的祖先目录键，不含文件名本身", () => {
    expect(ancestorDirectoryKeys("src/features/todos/TodoPanel.tsx")).toEqual([
      "src",
      "src/features",
      "src/features/todos",
    ]);
  });

  it("顶层文件没有祖先目录，并忽略空路径与多余分隔符", () => {
    expect(ancestorDirectoryKeys("index.html")).toEqual([]);
    expect(ancestorDirectoryKeys("/src//a.ts/")).toEqual(["src"]);
  });
});
