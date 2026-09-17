# workflows：AgentRun 业务工作流

本目录实现各 `run_type` 的业务编排。

按 [docs/09](../../docs/09-全栈TypeScript迁移方案.md) 第 8.2 节，四个工作流最终将以 LangGraph.js 图实现；
当前为**显式异步实现**，用于先打通链路与验证行为等价，函数签名与图状态的设计保持一致，便于后续替换。

文件：

- `assessment-generate.ts`：`runAssessmentGenerate` —— 前测题集生成
  （读取输入快照 → 内部接口取连接 → 解密凭据 → 模型生成 → 结构校验与一次修复 → 幂等持久化）。

已知缺口（阶段 5 补齐）：未接入 Tavily 远程 MCP，因此首轮不提供工具、`tool_call_count` 恒为 0，
三阶段恢复只实现了 initial 与 repair，缺少 tavily_recovery 兜底。
