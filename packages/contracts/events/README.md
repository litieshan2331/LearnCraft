# 异步事件契约

本目录存放 Web 与 Python Agent Worker 之间的可版本化 Outbox 事件 JSON Schema。

## 当前已实现

- [agent-run-requested.v1.schema.json](./agent-run-requested.v1.schema.json)：Web 在创建 `agent.agent_runs` 的同一 PostgreSQL 事务中写入 `public.outbox_events`；`agent-dispatcher` 校验后投递到 Celery 的 `agent.run` 队列。

载荷只包含 `agent_run_id`、`trace_id` 与 `task_version`。Prompt、用户资料、模型密钥和完整输出不进入 Redis。`agent_run_id` 同时是数据库运行 ID 与 Celery `task_id`，因此 Dispatcher 因进程中断重复投递时，Worker 能以持久化状态和幂等策略识别重复消息。

## 演进规则

任何不兼容字段变更必须创建新的 `*.vN.schema.json` 文件，不得覆写 v1。Web 写入事件、Dispatcher 解析和 Worker 消费新版本前，必须同时完成契约评审与回归测试。
