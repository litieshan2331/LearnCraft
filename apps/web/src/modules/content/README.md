# Content 限界上下文

本上下文负责受控资料、内容分块、检索引用与学习卡片内容。实战或调试卡片的 Demo 必须由受控流程预运行成功后才能发布。

资料与卡片规则放 `domain`，请求内容生成与读取放 `application`，Drizzle/对象存储/检索适配放 `infrastructure`，外部输入输出放 `interfaces`。

已实现 `POST /api/v1/plan-nodes/{node_id}/content-runs`：它只为当前有效路线中的节点创建 `card_content_generate` AgentRun（**目标级幂等**——该节点已有 queued/running 任务时直接返回那个任务，不再新建、也不报错，所以刷新页面后再点一次是安全的），创建成功后把节点 `content_status` 置为 `generating`（刷新后页面据此继续显示进度），并冻结目标、画像和节点摘要；任务成功由内部 `card-content-result` 把状态置 `ready`，**最终失败由 Worker 在同一事务里置回 `failed`**（见 worker 的 `agent-run-repository`）；Worker 已注册 NodeTutorAgent 与 card_content_generate 工作流，并通过内部 card-content-result 接收校验后的内容；已实现 `GET /api/v1/card-contents/{card_content_id}`，仅返回 ready 内容的公开知识区块和来源引用；`pitfalls_debug` 使用只含 `title`、`cause`、`fix` 的结构化数组。

卡片内容合同为 `card_content.v2`：`worked_example` 由 `files[]`（path / language / role / content）、`entry_file`、`call_sequence[]`（step / file / function / note）与字符串 `expected_output` 组成；历史 `card_content.v1` 行只在读取侧规范化（按 `// 路径` 注释行切分为多个文件，不回写、不重新生成）。示例区由 `presentation/components/worked-example-view.tsx` 与 `code-file-browser.tsx` 渲染“左侧目录树 + 右侧代码”（可点击切换文件、调用顺序可跳转）；因为节点内容是在客户端组件里 fetch 的，所以高亮不在组件里做，而是由读取接口在服务端用 `infrastructure/code-highlighter.ts` 预渲染成 `files[].html` 一起返回（只注册 JS/TS/TSX/JSX、Python、Java、Go、C/C++/C#、HTML/CSS/SCSS、SQL，主题 `github-dark`），浏览器不加载高亮引擎。节点内容的纯文本字段（`foundation`、`worked_example.explanation`、`expected_output`）支持四种轻量排版约定：空行分段、`- ` 列点（缩进 2 个空格为下一层）、`## ` 小节标题（加大字号 + primary 竖线）、行内 `**加粗**`；提示词要求列点一律用 `- `、不写数字编号，解析器仍兼容 `1.` / `1、` 并渲染成「1、2、3、」作为兜底；由 `presentation/content-text-blocks.ts` 解析、`presentation/components/content-text.tsx` 渲染。提示词只允许这四种，其余 Markdown 原样显示，改动时两层要同步。
