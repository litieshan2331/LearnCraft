/**
 * 示例文件的目录树构建（纯函数，便于单测）。
 *
 * 职责：把 `files[].path`（仓库相对路径）按 `/` 分段构建成嵌套树，用于左侧目录导航；
 * 保持输入顺序（模型给出的顺序通常就是依赖顺序：类型 → 封装 → 状态 → 视图），不做字母排序。
 *
 * 导出：
 * - CardContentFileTreeNode：目录/文件节点。
 * - buildCardContentFileTree：按路径列表构建树。
 * - ancestorDirectoryKeys：某个文件路径的全部祖先目录键（UI 的折叠状态与「展开到当前文件」都用它）。
 *
 * 目录节点键的约定：从根到该目录的路径片段用 `/` 连接（如 `src/features/todos`），
 * 与文件节点的完整路径同形但不带文件名；UI 用它作为折叠状态的键。
 */

export interface CardContentFileTreeNode {
  /** 目录名或文件名。 */
  name: string;
  /** 文件节点为完整路径；目录节点为 null。 */
  path: string | null;
  children: CardContentFileTreeNode[];
}

/** 按 path 逐级下降；同层已存在的目录直接复用（保持首次出现的顺序）。 */
function insertPath(roots: CardContentFileTreeNode[], path: string): void {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return;
  }
  let level = roots;
  let prefix = "";

  segments.forEach((segment, index) => {
    const isFile = index === segments.length - 1;
    prefix = prefix.length === 0 ? segment : prefix + "/" + segment;
    if (isFile) {
      level.push({ name: segment, path, children: [] });
      return;
    }
    let directory = level.find((node) => node.path === null && node.name === segment);
    if (directory === undefined) {
      directory = { name: segment, path: null, children: [] };
      level.push(directory);
    }
    level = directory.children;
  });
}

/**
 * 某文件路径的全部祖先目录键，顺序为由根到叶（不含文件名本身）。
 * 顶层文件返回空数组；空路径与多余分隔符按 buildCardContentFileTree 的同一套规则忽略。
 */
export function ancestorDirectoryKeys(path: string): string[] {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const keys: string[] = [];
  let prefix = "";
  for (const segment of segments.slice(0, -1)) {
    prefix = prefix.length === 0 ? segment : prefix + "/" + segment;
    keys.push(prefix);
  }
  return keys;
}

/** 按文件路径列表构建目录树。 */
export function buildCardContentFileTree(
  files: ReadonlyArray<{ path: string }>,
): CardContentFileTreeNode[] {
  const roots: CardContentFileTreeNode[] = [];
  for (const file of files) {
    insertPath(roots, file.path);
  }
  return roots;
}
