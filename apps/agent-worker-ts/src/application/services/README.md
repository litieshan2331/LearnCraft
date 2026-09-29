# services：应用服务

文件：

- `agent-workflow-registry.ts`：`AgentWorkflowRegistry`，把 `run_type` 映射到已注册的工作流。
- `tool-aware-generator.ts`：`runReactAgentSession` —— 单会话 ReAct 循环（工具回传、校验反馈自纠、
  轮数与工具调用双上限），可选 `onProgress` 上报实时进度。
- `trace-writer.ts`：`TraceWriter` —— Worker 完整模型与工具观测的持久化写入端口。
- `agent-progress.ts`：实时进度事件契约 —— `AgentProgressStep` / `AgentProgressEvent` /
  `AgentProgressReporter`；其中 `thinking.delta` 与 `thinking.completed` 携带模型思考原文
  （仅有的两类允许携带模型原文的事件），其余只含步骤与工具元数据；全部不落库、不写日志。
- `agent-thinking-stream.ts`：`AgentThinkingStream` / `createAgentThinkingStream` —— 思考原文上报：
  `push` 把流式增量**实时透传**（不缓冲、不合并、无阈值、无总量限制），`completeTurn` 上报该轮权威整段；
  只有工具调用需要缓冲完整结构化结果，思考流不做缓冲；供 ReAct 循环调用，不落库、不写日志。

约束：注册表只做路由，不包含业务规则；未注册的 `run_type` 由命令层转为
`AGENT_RUN_WORKFLOW_NOT_REGISTERED` 的不可重试失败，绝不伪造成功结果（与 Python 的 BaseAgent 一致）。
