# services：应用服务

文件：

- `agent-workflow-registry.ts`：`AgentWorkflowRegistry`，把 `run_type` 映射到已注册的工作流。
- `tool-aware-generator.ts`：`runReactAgentSession` —— 单会话 ReAct 循环（工具回传、校验反馈自纠、
  轮数与工具调用双上限），可选 `onProgress` 上报实时进度。
- `agent-progress.ts`：实时进度事件契约 —— `AgentProgressStep` / `AgentProgressEvent` /
  `AgentProgressReporter`；**只含步骤与工具元数据，不含模型原文，且不落库**。

约束：注册表只做路由，不包含业务规则；未注册的 `run_type` 由命令层转为
`AGENT_RUN_WORKFLOW_NOT_REGISTERED` 的不可重试失败，绝不伪造成功结果（与 Python 的 BaseAgent 一致）。
