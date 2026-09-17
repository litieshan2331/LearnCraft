# bootstrap：进程启动与配置

文件：

- `config.ts`：把环境变量收敛为受校验的配置对象：
  - `readAgentQueueConfig`：队列连接、键前缀、队列名、并发、锁时长、重试与退避；
  - `readOutboxDispatcherConfig`：Outbox 领取参数与**运行时路由映射**（`AGENT_RUNTIME_ROUTES`）；
  - `readModelEgressOptions`：受控出网参数（生产环境启用出网时强制要求代理）；
  - `readCoreInternalClientOptions`：Web 内部接口地址与服务密钥；
  - `parseRedisConnection` / `readRuntimeRoutes`：连接串与路由映射解析。

约定：所有并发、超时、重试与路由参数都来自环境变量，禁止硬编码（docs/09 §3.4）。
