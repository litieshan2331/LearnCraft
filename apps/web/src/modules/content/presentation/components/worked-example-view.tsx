/**
 * 「示例：从输入到结果」区块。
 *
 * 组件与函数：
 * - WorkedExampleView：渲染 explanation + 文件浏览器（目录树 / 代码 / 调用顺序）+ 预期输出。
 *
 * 说明：节点内容由客户端组件（plan-node-view）fetch 读取，本组件继承该客户端边界，因此保持**同步**；
 * 代码高亮已由读取接口在服务端预渲染成 `files[].html`，这里只负责切换与展示，浏览器不加载高亮引擎。
 */

import type { WorkedExample } from "../api/content-client";
import { CodeFileBrowser } from "./code-file-browser";
import { ContentText } from "./content-text";

export function WorkedExampleView({
  workedExample,
}: Readonly<{ workedExample: WorkedExample }>) {
  return (
    <>
      <ContentText
        className="mt-4 text-sm leading-8 text-muted-foreground"
        value={workedExample.explanation}
      />

      <CodeFileBrowser
        callSequence={workedExample.call_sequence}
        files={workedExample.files}
        initialPath={workedExample.entry_file}
      />

      <div className="mt-5 border-t border-border pt-5">
        <p className="text-xs tracking-[0.14em] text-primary">预期输出</p>
        <ContentText
          className="mt-3 text-sm leading-7 text-muted-foreground"
          value={workedExample.expected_output}
        />
      </div>
    </>
  );
}
