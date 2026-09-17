# queue：BullMQ 消费适配器

文件：

- `agent-run-processor.ts`：`createAgentRunProcessor` —— 校验队列载荷 → 调用命令层
  `executeAgentRun`（`retryCount` 取自 `job.attemptsMade`）→ 失败时调用 `handleAgentRunFailure`：
  - 可重试且未耗尽：数据库已记录下一次重试，抛普通错误让 BullMQ 按退避重投；
  - 已终态（不可重试、重试耗尽、未分类异常）：抛 `UnrecoverableError`，不再重投；
  - 载荷非法（拿不到 `agent_run_id`）：直接 `UnrecoverableError`，不写任何运行状态。
