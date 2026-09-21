# services：应用服务

文件：

- `agent-workflow-registry.ts`：`AgentWorkflowRegistry`，把 `run_type` 映射到已注册的工作流。
- `tool-aware-generator.ts`：`runReactAgentSession` —— 单会话 ReAct 循环（工具回传、校验反馈自纠、
  轮数与工具调用双上限），可选 `onProgress` 上报实时进度。
- `agent-progress.ts`：实时进度事件契约 —— `AgentProgressStep` / `AgentProgressEvent` /
  `AgentProgressReporter`；其中 `thinking.delta` 与 `thinking.completed` 携带模型思考原文
  （仅有的两类允许携带模型原文的事件），其余只含步骤与工具元数据；全部不落库、不写日志。
- `agent-thinking-stream.ts`：`AgentThinkingStream` / `createAgentThinkingStream` —— 思考增量的
  缓冲、阈值合并（字符数或时间）与轮末补发，以及单次运行的总量上限；供 ReAct 循环调用，不落库。

约束：注册表只做路由，不包含业务规则；未注册的 `run_type` 由命令层转为
`AGENT_RUN_WORKFLOW_NOT_REGISTERED` 的不可重试失败，绝不伪造成功结果（与 Python 的 BaseAgent 一致）。
