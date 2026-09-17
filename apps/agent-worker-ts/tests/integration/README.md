# integration：真实环境用例（默认跳过）

这些用例连接真实数据库；其中端到端用例还会产生真实模型费用并写入真实数据，因此必须显式开启才会运行。

文件：

- `live-readonly.test.ts`：**只执行 SELECT**。核对 `agent` schema 的列与 Repository 使用的一致，
  并解密一条真实模型连接凭据（只输出长度与前缀，不输出明文）。
  需要 `AGENT_TS_TEST_DATABASE_URL`、`CREDENTIAL_ENCRYPTION_KEY`、`CREDENTIAL_ENCRYPTION_KEY_VERSION`。
- `live-e2e.test.ts`：完整链路 —— 写入夹具（goal + agent_run）→ `beginExecution` 领取 → 解密凭据 →
  调用真实 Provider（SSE）→ `markSucceeded` 回写 → 校验事件序列与重复投递幂等。
  在上述三项之外还需要 `AGENT_TS_LIVE_E2E=1` 作为显式确认。

端到端用例不会自动删除夹具（便于人工核对运行记录），结束时打印清理 SQL。
只允许在本机开发库运行，不得指向生产库；运行命令见上级目录的 README。
