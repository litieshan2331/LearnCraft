# services：应用服务

文件：

- `agent-workflow-registry.ts`：`AgentWorkflowRegistry`，把 `run_type` 映射到已注册的工作流。

约束：注册表只做路由，不包含业务规则；未注册的 `run_type` 由命令层转为
`AGENT_RUN_WORKFLOW_NOT_REGISTERED` 的不可重试失败，绝不伪造成功结果（与 Python 的 BaseAgent 一致）。
