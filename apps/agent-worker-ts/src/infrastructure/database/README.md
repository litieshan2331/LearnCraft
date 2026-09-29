# database：Agent 编排持久化

本目录只访问 `agent.agent_runs`、`agent.agent_run_events` 与 `agent.agent_trace_events`；学习目标、路线、题集与卡片内容等核心业务表
一律经 Web 内部 API 写入，不得直连，也不得在 Worker 内复制 Web 的领域模型。

唯一例外：`card_content_generate` 且目标为 `plan_node` 的任务**最终失败**时，`markFailed` 会在同一事务里
把 `public.plan_nodes.content_status` 从 `generating` 置回 `failed`（成功路径由 Web 的 `card-content-result` 置 `ready`），
否则页面会永远停在“生成中”。这是唯一一处跨 schema 写入，不要扩大范围。

文件：

- `agent-run-repository.ts`：`PgAgentRunRepository`，提供 `beginExecution`（行锁 + 状态机）、`isCancelled`、
  `markSucceeded` / `markRetryScheduled` / `markFailed`，以及行锁内严格递增的事件序号。
- `agent-trace-writer.ts`：`PgTraceWriter`，在 AgentRun 行锁内写入完整模型和工具观测 JSONB 事件。

必须保持的不变量：终态短路保证重复投递幂等；`retry_count` 单调不减；错误字段按 100/1000 字符截断；
时间统一使用数据库 `now()`；与现状一致地不更新 `updated_at`。
