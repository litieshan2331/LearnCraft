# 异步事件契约

本目录预留给 Outbox 事件的 JSON Schema，例如 `AgentRunRequested`、`PlanGenerated`、`CardContentGenerated` 和 `CodeRunFinished`。

当前尚未创建事件生产者或消费者，因此不提前定义无法验证的事件字段。实现 Outbox 时，应先在此处定义并评审 schema，再编写 Web 与 Worker 的处理代码。
