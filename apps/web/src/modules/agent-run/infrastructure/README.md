# AgentRun 基础设施层

`DrizzleAgentRunRepository` 在一个 PostgreSQL 事务中写入 `agent_runs`、`agent_run_events` 与 `outbox_events`。取消时先锁定 AgentRun 行，再追加连续的 `run.cancelled` 事件，避免与 Worker 的状态推进产生竞争。

`agent-progress-subscriber.ts` 订阅 Agent Worker 发布的 `learncraft:agent-progress:{runId}` 频道，
把消息解析为经 Zod 白名单校验的进度事件；未配置 `AGENT_PROGRESS_REDIS_URL` 或连接失败时抛
`AgentProgressUnavailableError`，由 SSE 适配器降级为「没有实时进度」，不影响状态轮询与最终结果。
进度是临时通道：不落库、不重放。
