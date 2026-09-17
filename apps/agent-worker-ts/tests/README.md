# tests：测试

本目录按“能否脱离外部依赖运行”分层：单元测试默认全部执行；连接真实数据库或真实 Provider 的用例
必须由环境变量显式开启，否则整体跳过。

文件：

- `public-address.test.ts`、`egress-policy.test.ts`、`safe-egress-client.test.ts`：地址判定、出网策略与
  出网客户端（使用假传输层，不发真实请求）。
- `pinned-transport.test.ts`：回环 TLS 端到端，验证“连接钉死 IP + 按原域名校验证书”，含 CONNECT 代理路径。
- `credential-decryptor.test.ts`：凭据信封解密，含由 Python 生成的跨语言测试向量。
- `agent-run-repository.test.ts`：Repository 的 SQL、事务边界与幂等语义（使用假连接池）。
- `core-internal-client.test.ts`：内部接口客户端的鉴权、错误分类与响应契约校验（使用假 fetch）。
- `model-gateway.test.ts`：载荷构造、SSE 聚合与重试（使用假出网端口）。
- `assessment-question-set.test.ts`：题集契约与代码围栏剥离。
- `assessment-generate.test.ts`：工作流的输入契约、阶段控制流与错误取舍。
- `execute-agent-run.test.ts`：命令层的路由、错误归类、真实 token 回写与重试策略。
- `bootstrap-config.test.ts`：Redis 连接串与运行时路由映射解析。
- `outbox-dispatcher.test.ts`：领取 SQL（含 `FOR UPDATE OF o`）、状态回写与优雅关闭。
- `bullmq-agent-queue.test.ts`：队列装配与退避数值（mock bullmq）。
- `agent-run-processor.test.ts`：消费适配器的重投与 `UnrecoverableError` 语义。
- `integration/`：真实环境用例，默认跳过。

约定：测试文件与被测模块同名；会花钱或写真实数据的用例一律放在 `integration/`，并读取环境变量开关。
