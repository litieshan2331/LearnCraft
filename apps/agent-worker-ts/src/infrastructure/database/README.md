# database：Agent 编排持久化

本目录只访问 `agent.agent_runs` 与 `agent.agent_run_events`；学习目标、路线、题集与卡片内容等核心业务表
一律经 Web 内部 API 写入，不得直连，也不得在 Worker 内复制 Web 的领域模型。

文件：

- `agent-run-repository.ts`：`PgAgentRunRepository`，提供 `beginExecution`（行锁 + 状态机）、`isCancelled`、
  `markSucceeded` / `markRetryScheduled` / `markFailed`，以及行锁内严格递增的事件序号。

必须保持的不变量：终态短路保证重复投递幂等；`retry_count` 单调不减；错误字段按 100/1000 字符截断；
时间统一使用数据库 `now()`；与现状一致地不更新 `updated_at`。
