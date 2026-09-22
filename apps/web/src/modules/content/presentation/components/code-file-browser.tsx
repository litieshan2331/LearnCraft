/**
 * 示例文件浏览器（客户端组件）：左侧可折叠目录树 + 右侧文件内容 + 调用顺序跳转。
 *
 * 组件与函数：
 * - CodeFileBrowser：持有「当前选中文件」与「已折叠的目录键」两份状态；点击目录切换折叠，
 *   点击文件或调用顺序中的任一项都会切换右侧文件，并自动展开目标文件所在的目录。
 * - FileTreeNode：递归渲染目录/文件节点；目录可折叠（箭头 + aria-expanded），文件可点击。
 *
 * 说明：
 * - 代码高亮在服务端完成（读取接口预渲染成已转义的内联 HTML），本组件只负责切换与渲染，
 *   因此浏览器端不加载高亮引擎；
 * - 调用顺序里的 `文件 › 函数` 指明「哪个文件里的哪个函数」，点击即定位到该文件
 *   （不做行级跳转：函数在文件中的行号不做结构化输出，避免模型编造行号）。
 */

"use client";

import { ChevronDown, ChevronRight, FileCode2, Folder } from "lucide-react";
import { useState } from "react";

import {
  ancestorDirectoryKeys,
  buildCardContentFileTree,
  type CardContentFileTreeNode,
} from "../card-content-file-tree";

export interface CodeFileView {
  path: string;
  language: string;
  role: string;
  /** 服务端预渲染的、已转义的内联高亮 HTML。 */
  html: string;
}

export interface CodeCallStepView {
  step: number;
  file: string;
  function: string;
  note: string;
}

export function CodeFileBrowser({
  files,
  initialPath,
  callSequence,
}: Readonly<{
  files: CodeFileView[];
  initialPath: string;
  callSequence: CodeCallStepView[];
}>) {
  const [activePath, setActivePath] = useState(initialPath);
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  const fallback = files[0];
  if (fallback === undefined) {
    return null;
  }
  const active = files.find((file) => file.path === activePath) ?? fallback;
  const tree = buildCardContentFileTree(files);

  /** 切换右侧文件，并展开目标文件的所有祖先目录（从调用顺序跳转时尤其需要）。 */
  function selectFile(path: string): void {
    setActivePath(path);
    setCollapsedKeys((current) => {
      const ancestors = ancestorDirectoryKeys(path);
      if (!ancestors.some((key) => current.has(key))) {
        return current;
      }
      const next = new Set(current);
      for (const key of ancestors) {
        next.delete(key);
      }
      return next;
    });
  }

  /** 折叠 / 展开一个目录。 */
  function toggleDirectory(key: string): void {
    setCollapsedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
      <nav aria-label="示例文件" className="rounded-xl border border-border/70 bg-background/50 p-3">
        <p className="px-2 pb-2 text-xs tracking-[0.14em] text-muted-foreground">文件</p>
        <ul className="space-y-0.5">
          {tree.map((node) => (
            <FileTreeNode
              activePath={active.path}
              collapsedKeys={collapsedKeys}
              depth={0}
              key={node.path ?? node.name}
              node={node}
              nodeKey={node.path ?? node.name}
              onSelect={selectFile}
              onToggle={toggleDirectory}
            />
          ))}
        </ul>
      </nav>

      <div className="min-w-0">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate font-mono text-xs text-muted-foreground">{active.path}</p>
          <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">{active.language}</span>
        </div>
        {/* Shiki 只输出 span 与转义后的文本；容器样式沿用原有深色代码块。 */}
        <pre className="mt-2 overflow-x-auto rounded-[1.25rem] border border-[#17353a] bg-[#17353a] p-4 font-mono text-sm leading-6 text-[#eef7f6]">
          <code dangerouslySetInnerHTML={{ __html: active.html }} />
        </pre>

        {callSequence.length > 0 ? (
          <div className="mt-5 border-t border-border pt-5">
            <p className="text-xs tracking-[0.14em] text-primary">调用顺序</p>
            <ol className="mt-3 space-y-1.5">
              {callSequence.map((step) => {
                const target = files.some((file) => file.path === step.file) ? step.file : null;
                const label = step.function.length > 0 ? step.file + " › " + step.function : step.file;
                return (
                  <li key={String(step.step) + "|" + step.file + "|" + step.function}>
                    <button
                      className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm leading-6 transition-colors enabled:hover:bg-secondary/60 disabled:cursor-default"
                      disabled={target === null}
                      onClick={() => {
                        if (target !== null) {
                          selectFile(target);
                        }
                      }}
                      type="button"
                    >
                      <span className="shrink-0 tabular-nums text-muted-foreground">{step.step}.</span>
                      <span className="min-w-0">
                        <span className={"font-mono text-xs " + (target === null ? "text-muted-foreground" : "text-foreground")}>{label}</span>
                        {step.note.length > 0 ? <span className="block text-muted-foreground">{step.note}</span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 递归渲染目录树：目录行可点击折叠/展开，文件行点击后切换右侧内容。 */
function FileTreeNode({
  node,
  nodeKey,
  activePath,
  collapsedKeys,
  depth,
  onSelect,
  onToggle,
}: Readonly<{
  node: CardContentFileTreeNode;
  /** 该节点在树里的稳定键：文件用完整路径，目录用「从根到该目录的路径片段」。 */
  nodeKey: string;
  activePath: string;
  collapsedKeys: ReadonlySet<string>;
  depth: number;
  onSelect: (path: string) => void;
  onToggle: (key: string) => void;
}>) {
  if (node.path === null) {
    const collapsed = collapsedKeys.has(nodeKey);
    return (
      <li>
        <button
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
          onClick={() => onToggle(nodeKey)}
          style={{ paddingLeft: 6 + depth * 12 }}
          type="button"
        >
          {collapsed ? (
            <ChevronRight aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown aria-hidden className="size-3.5 shrink-0" />
          )}
          <Folder aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
        {collapsed ? null : (
          <ul className="space-y-0.5">
            {node.children.map((child) => {
              const childKey = child.path ?? nodeKey + "/" + child.name;
              return (
                <FileTreeNode
                  activePath={activePath}
                  collapsedKeys={collapsedKeys}
                  depth={depth + 1}
                  key={childKey}
                  node={child}
                  nodeKey={childKey}
                  onSelect={onSelect}
                  onToggle={onToggle}
                />
              );
            })}
          </ul>
        )}
      </li>
    );
  }

  const isActive = node.path === activePath;
  return (
    <li>
      <button
        aria-current={isActive ? "true" : undefined}
        className={
          "flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left font-mono text-xs transition-colors "
          + (isActive ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
        }
        onClick={() => onSelect(node.path as string)}
        style={{ paddingLeft: 6 + depth * 12 }}
        type="button"
      >
        <FileCode2 aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}
