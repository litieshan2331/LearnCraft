# infrastructure：基础设施层

本目录实现与外部系统的交互，并向上层提供端口实现；不包含学习路线、题集或教学内容的业务规则。

子目录：

- `llm/`：模型受控出网（地址策略、固定 IP 连接、响应限制与审计）与用户 Provider 凭据解密。
- `database/`：AgentRun 运行状态与审计事件的 PostgreSQL 访问。

后续将添加 `mcp/`（Tavily 远程 MCP）、`security/`、`observability/` 与 `cpu/`（受控线程池）。
