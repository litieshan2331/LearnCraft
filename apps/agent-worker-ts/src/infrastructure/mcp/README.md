# infrastructure/mcp：远程 MCP 工具接入

本目录接入固定的官方 Tavily 远程 MCP 端点，对应 Python 的 `infrastructure/mcp/tavily_remote_mcp.py`。

文件：

- `tavily-tool-gateway.ts`：`TavilyToolGateway` —— 模型只看到 `tavily_search` 一个工具，
  网关内部执行 `tools/list` 能力校验与 `tavily_search` → `tavily_extract` 两步，
  并把失败编码成可安全回传给模型的工具结果（`ToolExecutionResult`）。
  同时导出 `RedisDailyQuotaCounter`（每日配额）与若干纯函数供测试与排障复用。

要点：

- **固定端点与鉴权**：只访问 `https://mcp.tavily.com/mcp/`，Bearer Key 来自 `TAVILY_API_KEY`，
  并带 `DEFAULT_PARAMETERS` 默认检索参数；不把远端 Schema 透传给模型。
- **参数按远端 schema 过滤**：调用参数会按 `tools/list` 公布的 `inputSchema.properties` 过滤。
  远端 2026-09 起 `tavily_extract` 已不接受 `chunks_per_source`，Python 的硬编码参数会被远端以
  `-32603` 拒绝；过滤后保留 Python 的参数语义，又不会因为远端删参而整体失败。
- **fail-closed 配额**：每日额度按账户在 Redis 原子计数（`TAVILY_QUOTA_KEY_PREFIX` + 账户 + UTC 日期），
  超过额度会回滚计数；配额 Redis 不可用时返回 `TAVILY_QUOTA_UNAVAILABLE`，绝不绕过配额发起联网。
- **出网**：配置了 `MODEL_EGRESS_PROXY_URL` 时经 HTTP CONNECT 代理，统一关闭重定向并设置连接/读取超时。
- **不可信内容**：网页正文按 1500 字符截断，并在结果里标记 `content_is_untrusted: true`。
