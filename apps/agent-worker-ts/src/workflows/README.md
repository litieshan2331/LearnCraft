# workflows：AgentRun 业务工作流

本目录实现各 `run_type` 的业务编排。每个工作流一个子目录，目录内按职责再分文件夹
（`schema/` 输入与输出合同、`prompts/` 提示词、`recovery/` 兜底宽松规范化），
跨工作流复用的模块放在 `shared/`。

四个工作流都是**单一 persona 的 ReAct 会话**：一次运行只有一个人格与一个持续累积的会话，
联网工具由模型自主决定是否调用（非强制），校验失败时把字段路径回灌同一会话让模型自纠。
会话循环在 `application/services/tool-aware-generator.ts`（`runReactAgentSession`）。

轮数上限按工作流注入：`AGENT_REACT_MAX_TURNS_ASSESSMENT` / `_POSTTEST` / `_PLAN` / `_CARD_CONTENT`
（默认 5 / 5 / 10 / 5），语义是一次运行内允许的模型调用次数（含只产生工具调用的轮次），因此同时是成本上限。

当前为**显式异步实现**，函数签名与状态设计保持可替换性，便于日后改为 LangGraph.js 图
（可选项，见 `docs/09` 待办清单第 7 项）。

子目录：

- `assessment-generate/`：`assessment_generate` 前测题集生成
  （读取输入快照 → 内部接口取连接 → 解密凭据 → 会话内生成与自纠 → 幂等持久化）。
- `posttest-generate/`：`posttest_generate` 节点后测生成
  （先读固定 CardContent 上下文，再取账户默认模型连接，以节点内容与 `teaching_memory` 为主要依据出题，
  全程允许联网核对 → 幂等持久化）。
- `plan-generate/`：`plan_generate` 学习路线生成
  （取连接 → 会话内生成与自纠，严格校验失败时先经 `recovery/` 宽松规范化再严格校验 → 幂等持久化）。
- `card-content-generate/`：`card_content_generate` 节点内容生成
  （取连接 → 会话内生成与自纠，每次解析都先宽松规范化再严格校验 → 幂等持久化）。
- `shared/`：题集校验与元数据映射（前测与后测共用）与 Python 真值语义兼容层
  （路线与节点内容的规范化器共用）。

`src/main/worker.ts` 当前注册的 `run_type`：`assessment_generate`、`posttest_generate`、`plan_generate`、`card_content_generate`
（四个 P0 工作流已全部落地，每个都有单元测试与真实端到端用例）。
未注册的类型由命令层转为 `AGENT_RUN_WORKFLOW_NOT_REGISTERED` 的不可重试失败，不会伪造成功结果。

## 联网工具（Tavily 远程 MCP）

四个工作流共用 `infrastructure/mcp/tavily-tool-gateway.ts` 与 `application/services/tool-aware-generator.ts`：

- 工具在会话内**自由调用、不强制**：每轮都携带 `tavily_search` 且 `toolChoice=auto`，
  直到可见工具调用数达到 `AGENT_TOOL_MAX_CALLS` 才停止提供工具，强制模型基于已有资料作答；
- 工具失败不中断会话：失败结果编码成 tool 消息回传模型，由模型自行判断是否换查询或凭已有知识继续；
- 可见工具调用数写入 `tool_call_count`，assessment 另写 `search_extract`（0/非 0 决定）；
  每日配额按账户经 Redis 原子计数，配额不可用时拒绝联网而不是绕过。

**已知差异：** 调用参数按远端 `tools/list` 公布的 schema 过滤。远端 2026-09 起 `tavily_extract`
不再接受 `chunks_per_source`，Python 的硬编码参数会被远端以 `-32603` 拒绝；过滤后保留 Python 的参数语义，
同时不会因为远端删参而整体失败。
