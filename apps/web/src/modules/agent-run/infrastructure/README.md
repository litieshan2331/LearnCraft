# AgentRun 基础设施层

`DrizzleAgentRunRepository` 在一个 PostgreSQL 事务中写入 `agent_runs`、`agent_run_events` 与 `outbox_events`。取消时先锁定 AgentRun 行，再追加连续的 `run.cancelled` 事件，避免与 Celery Worker 的状态推进产生竞争。
