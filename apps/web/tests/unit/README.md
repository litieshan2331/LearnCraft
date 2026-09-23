# Web 单元测试

不依赖真实数据库与网络服务的领域、应用层与纯函数测试：

- `card-content-worked-example-normalizer.test.ts`：`worked_example` 读侧归一化（v2 直通、v1 按 `// 路径` 拆分、不可用返回 null）。
- `code-highlighter.test.ts`：Shiki 高亮与 HTML 转义，白名单外语言回落纯文本，逐文件高亮覆盖每个路径。
- `card-content-presenter.test.ts`：读取响应形状（`files[].html` 取预渲染映射、`expected_output` 保持字符串、snake_case 映射）。
- `card-content-file-tree.test.ts`：示例文件目录树构建（逐级嵌套、复用同层目录、保持输入顺序）。
- `content-text-blocks.test.ts`：长文本轻量排版解析（空行分段、`- `/`1. `/`1、` 列表、缩进嵌套、`## ` 标题、`**加粗**` 片段、无标记内容降级）。
- `content-text.test.tsx`：结构化纯文本组件的服务端渲染结果（段落 / 标题 / 嵌套列表 / 加粗）与 HTML 转义。
- `agent-progress-storage.test.ts`：进度面板的 sessionStorage 暂存（读回、runId 不匹配、过期、结构非法、上限裁剪、读写抛错降级）。
- `agent-run-progress.test.tsx`：进度面板挂载时从暂存快照恢复步骤与思考（静态渲染，不建 SSE）。

约定：测试文件直接放在本目录（不与被测的 `.ts` 混放），文件名与被测模块同名。
本工程尚未配置 vitest 的 `@/` 路径别名——`@/*` 只在 `tsc` 的 `paths` 中生效，测试代码里的 `@/` 只能用于会被编译期擦除的
`import type`——因此此处统一用 `../../src/...` 相对路径导入被测模块。
