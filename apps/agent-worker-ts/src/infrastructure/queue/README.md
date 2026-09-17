# queue：Outbox 投递与 BullMQ 队列

文件：

- `outbox-dispatcher.ts`：`OutboxDispatcher` —— 以 `FOR UPDATE OF o SKIP LOCKED` 领取本运行时负责的
  `run_type` 事件，校验契约后投递，并回写 `published` / `failed`（退避）/ `dead`；
  支持优雅关闭（停止领取并立即释放已领取未发布的事件，而不是等 900 秒锁租约）。
- `bullmq-agent-queue.ts`：BullMQ 装配 —— `jobId` 使用 `agent_run_id` 去重、`attempts = maxRetries + 1`、
  自定义退避复用 10/20/40… 封顶 300 秒、`lockDuration` 大于任务硬超时、键前缀与 Celery 完全隔离。

**关键点**：领取语句必须写 `FOR UPDATE OF o`。写成裸 `FOR UPDATE` 会连带锁住 `agent.agent_runs`，
与 `beginExecution` 的行锁互相阻塞。该性质由集成测试在真实数据库上用两个事务验证。
