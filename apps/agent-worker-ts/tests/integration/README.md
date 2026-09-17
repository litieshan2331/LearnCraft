# integration：真实环境用例（默认跳过）

这些用例连接真实数据库；其中端到端用例还会产生真实模型费用并写入真实数据，因此必须显式开启才会运行。

文件：

- `live-readonly.test.ts`：**只执行 SELECT**。核对 `agent` schema 的列与 Repository 使用的一致，
  并解密一条真实模型连接凭据（只输出长度与前缀，不输出明文）。
  需要 `AGENT_TS_TEST_DATABASE_URL`、`CREDENTIAL_ENCRYPTION_KEY`、`CREDENTIAL_ENCRYPTION_KEY_VERSION`。
- `live-e2e.test.ts`：完整链路 —— 写入夹具（goal + agent_run）→ `beginExecution` 领取 → 解密凭据 →
  调用真实 Provider（SSE）→ `markSucceeded` 回写 → 校验事件序列与重复投递幂等。
  在上述三项之外还需要 `AGENT_TS_LIVE_E2E=1` 作为显式确认。
- `live-assessment.test.ts`：**真实 assessment_generate 全链路** —— 夹具（goal + queued AgentRun）→
  `beginExecution` 领取 → 经 Web 内部接口读取默认模型连接 → 解密凭据 → 模型生成 10 道题 →
  结构校验 → 经内部接口 assessment-result 幂等持久化 → `markSucceeded` 回写 →
  校验落库题集（题数与题目条数）与事件序列，并用占位载荷复验内部接口幂等性。
  需要 `AGENT_TS_LIVE_E2E=1`、`AGENT_TS_TEST_DATABASE_URL`、`CORE_INTERNAL_BASE_URL`、
  `INTERNAL_SERVICE_SECRET`、`CREDENTIAL_ENCRYPTION_KEY` 与 `CREDENTIAL_ENCRYPTION_KEY_VERSION`；
  单次运行约 20–30 秒，并产生真实模型费用。

- `live-queue.test.ts`：队列链路（真实 Redis）。用例一在真实数据库上校验领取 SQL：路由过滤生效，
  且 `FOR UPDATE OF o` 不会锁住 `agent_runs`（用第二个事务做 `FOR UPDATE NOWAIT` 证明，裸 `FOR UPDATE` 会得到 55P03）；
  用例二发布到 BullMQ 并由 Worker 消费完成真实 AgentRun。需要 `AGENT_TS_QUEUE_REDIS_URL`，
  模型调用部分额外需要 `AGENT_TS_LIVE_QUEUE_MODEL=1`；使用独立队列前缀，不污染生产键。

端到端用例不会自动删除夹具（便于人工核对运行记录），结束时打印清理 SQL。
只允许在本机开发库运行，不得指向生产库；运行命令见上级目录的 README。
