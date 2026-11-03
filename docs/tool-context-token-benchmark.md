# 工具结果四字段裁剪 token 测量方案

## 测量对象

同一次 Tavily `search → extract` 的结果生成两份 tool message：

- 原始版本：完整 `search` 和 `extract` payload 的 JSON。
- 裁剪版本：线上网关实际回传的 `{"ok":...,"code":...,"message":...,"data":...}` JSON。

两份结果使用相同的查询、结果数和来源选择，避免把检索内容差异误认为裁剪收益。`data` 内部仍保留回答所需的来源和正文，四字段契约只收敛顶层结构；网页正文的 1500 字符限制继续由 Tavily 网关执行。

## 计算公式

基准命令默认按 UTF-8 字节数估算 token：

```text
估算 token = ceil(UTF-8 字节数 / TAVILY_BENCHMARK_BYTES_PER_TOKEN)
```

默认除数为 4。它用于比较同一模型和同一编码假设下的相对变化，不代替 Provider 的精确 tokenizer。工具结果在后续 `N` 次模型请求中会被重复放入上下文，因此：

```text
累计原始上下文 token = 原始结果 token × N
累计裁剪上下文 token = 裁剪结果 token × N
累计节省 token = (原始结果 token - 裁剪结果 token) × N
节省比例 = (原始字节数 - 裁剪字节数) / 原始字节数
```

`N` 由 `TAVILY_BENCHMARK_REQUESTS_AFTER_TOOL` 指定。模型网关已返回真实 `inputTokens` 时，应将每轮真实值作为账单依据，并用本基准的字节/token 结果解释其中工具结果的相对贡献。

## 运行方式

默认不联网。复制 `infra/.env.example` 的 `TAVILY_BENCHMARK_*` 参数到未提交的 `infra/.env`，设置：

```dotenv
TAVILY_BENCHMARK_ALLOW_NETWORK=true
TAVILY_BENCHMARK_API_KEY=替换为测试用 Tavily Key
TAVILY_BENCHMARK_QUERY=TypeScript 5 的 satisfies 运算符
```

然后执行：

```bash
pnpm measure:tool-context
```

命令只发起一次显式的 Tavily MCP 基准调用，不接入 Worker 常驻路径，也不自动执行 AgentRun。
`TAVILY_BENCHMARK_OUTPUT_FILE` 可保存 JSON 报告；`TAVILY_BENCHMARK_INCLUDE_PAYLOAD=true` 才会把完整网页
payload 写入报告，默认只保存统计和裁剪结果，避免报告膨胀。

## 结果解读

优先查看 `measurement.saved.cumulativeEstimatedTokens` 和 `measurement.saved.reductionPercent`。
前者回答“工具结果在设定的后续轮数里少带了多少 token”，后者回答“单条工具消息缩短了多少”。
需要评估端到端账单时，再把同一批次开启/关闭裁剪的模型请求分别运行多次，比较模型返回的
`usage.inputTokens` 总和；不要把 Tavily 网络响应耗时或 Tavily API 费用计入 token 节省。
