# bootstrap：进程启动与配置

文件：

- `config.ts`：把环境变量收敛为受校验的配置对象：
  - `readAgentQueueConfig`：队列连接、键前缀、队列名、并发、锁时长、重试与退避；
  - `readOutboxDispatcherConfig`：Outbox 领取参数（只有一套运行时，因此不再有 run_type 路由映射）；
  - `readModelEgressOptions`：受控出网参数（生产环境启用出网时强制要求代理）；
  - `readModelRateLimitSettings`：模型限流 v1 参数（全局并发、API Key+模型并发/RPM、用户+模型并发/RPM）；
  - `readCoreInternalClientOptions`：Web 内部接口地址与服务密钥；
  - `parseRedisConnection` / `formatRedisConnection`：连接串解析与还原。

约定：所有并发、超时与重试参数都来自环境变量，禁止硬编码。
