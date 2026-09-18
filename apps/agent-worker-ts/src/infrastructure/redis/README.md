# infrastructure/redis：最小 RESP 客户端

本目录只提供配额计数需要的 Redis 命令子集，避免为三条命令引入额外依赖。

文件：

- `resp-client.ts`：`RespRedisClient` —— 按 `redis://` 连接串（支持密码、用户名与 db 号）建立连接，
  顺序执行命令并解析简单字符串、错误、整数与批量字符串四种回复；
  `parseRedisUrl` 解析连接串，`RespRedisError` 表示连接、超时或协议错误。

约定：

- 连接与命令超时默认各 2 秒，与 Python 侧 `redis.asyncio` 的 2 秒设置一致。
- 连接失败或超时时抛出 `RespRedisError`，由调用方决定降级方式；Tavily 配额据此 fail-closed 拒绝联网。
- 只实现 `+`、`-`、`:`、`$` 四种回复；遇到数组等未实现的类型会抛出明确错误，不会静默返回错误结果。
- 暂不支持 `rediss://`（TLS）连接串，需要时会显式报错而不是降级为明文连接。
