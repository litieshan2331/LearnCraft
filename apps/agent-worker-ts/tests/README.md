# tests：测试

本目录按“能否脱离外部依赖运行”分层：单元测试默认全部执行；连接真实数据库或真实 Provider 的用例
必须由环境变量显式开启，否则整体跳过。

文件：

- `public-address.test.ts`、`egress-policy.test.ts`、`safe-egress-client.test.ts`：地址判定、出网策略与
  出网客户端（使用假传输层，不发真实请求）。
- `pinned-transport.test.ts`：回环 TLS 端到端，验证“连接钉死 IP + 按原域名校验证书”，含 CONNECT 代理路径。
- `credential-decryptor.test.ts`：凭据信封解密，含由 Python 生成的跨语言测试向量。
- `agent-run-repository.test.ts`：Repository 的 SQL、事务边界与幂等语义（使用假连接池）。
- `integration/`：真实环境用例，默认跳过。

约定：测试文件与被测模块同名；会花钱或写真实数据的用例一律放在 `integration/`，并读取环境变量开关。
