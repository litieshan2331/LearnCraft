# 学习助手对话图

这里实现独立的 LangGraph.js 三 Agent 对话图：主 Agent 将错题归因与苏格拉底导师当作两个委派工具，图节点直接从子 Agent 回到主 Agent。子 Agent 可以调用业务读工具、Skill 与共享 Tavily 网关，工具白名单不包含继续委派。四个既有生成工作流继续使用原执行器。

## 文件与调用顺序

- `index.ts`：装配出口。
- `graph.ts`：编译主图、检查运行身份与固定连接、恢复同一运行。
- `state.ts`：可序列化状态、消息幂等合并、20 轮模型窗口。
- `ports.ts`：模型、可信取数和消息持久化端口合同。
- `agents/main-agent.ts`：主 Agent 节点入口；每次只作一个模型决策，后续路由由 LangGraph 完成。
- `agents/langchain-agent-runner.ts`：装配三个固定 Agent，执行主 Agent 单轮决策、主只读工具和两个子 Agent 节点，并绑定委派 `tool_call_id`。
- `agents/langchain-model-adapter.ts`：把 LangChain 消息和工具定义转成现有受控模型网关合同。
- `agents/shared.ts`：稳定消息标识、角色级 ReAct 上限错误和嵌套轨迹。
- `nodes/load-context-node.ts`、`nodes/persist-nodes.ts`：分别负责上下文准备和消息持久化；工具循环由 LangGraph 节点回环承担。
- `tools/index.ts`：业务查询、动态 Skill、Tavily、两个子 Agent 的工具定义。
- `prompts/main-agent-prompt.ts`、`error-attribution-prompt.ts`、`socratic-tutor-prompt.ts`：每个 Agent 各自完整维护七节提示词、可信上下文、输出合同和示例。
- LangChain ReAct 回复直接保存为自然语言，不存在整段 JSON 修复节点。
- `schemas/index.ts`：运行输入、输出、证据、主要问题等 Zod 合同。
- `../../infrastructure/database/learning-assistant-runtime-store.ts`：独立轨迹、原子模型调用计数、内部分页查询。

```text
START → prepare → main (单轮 Function Calling)
                         ├→ 只读业务 / Skill / Tavily 工具
                         ├→ analyze_wrong_answer → error_agent → main
                         ├→ generate_socratic_question → tutor_agent → main
                         └→ 自然语言回复 → persist → END
```

子 Agent 不可互相委派，仅注册只读业务、Skill 和 Tavily 工具。子 Agent 的自由文本作为绑定原 `tool_call_id` 的 `ToolMessage` 直接返回主 Agent，不经过 `child_result` 或 `main_resume` 节点；调用失败也以脱敏工具错误返回，由主 Agent 决定重试、降级或终止。主 Agent 的只读工具由 `main_read_tool` 节点执行后回到主 Agent；主图和每个 LangChain 子 Agent 使用稳定 thread ID 写入 Checkpoint，已持久化消息按固定 ID 合并，恢复时不会重复业务消息。

## 装配约定

先创建 `createLearningAssistantCheckpointer(databaseUrl)` 和 `PgLearningAssistantRuntimeStore(pool)`，再注入 `LearningAssistantDependencies`，调用 `createLearningAssistantGraph(deps)`、`runLearningAssistant(graph, deps, input)`。

`connection` 必须是该用户本次运行确定的有效默认连接；`input` 只保存连接 ID、模型 ID，不保存密钥。恢复时按本次运行保存的连接快照重新装配，不能重新选择用户此刻的默认连接。网关通过请求级 `traceWriter` 使用学习助手轨迹，避免写到旧 `agent_runs` 外键。调用网关的 `beforeModelAttempt` 在每次实际尝试之前原子记录调用计数。主 Agent、归因子 Agent、导师子 Agent 分别使用服务端装配的 ReAct 轮数上限（默认 6/4/4），上限保存在 Checkpoint；工具不会因为接近上限而被主动撤掉，提示词负责引导模型输出最终结构，图条件边负责停止回环。

`loadInitialMessages` 仅在没有已初始化的 Checkpoint 时读取业务历史。之后模型消息来源为 Checkpoint，每次只取最近 20 个用户轮，包含当前轮并保留该轮完整工具链。业务消息表和页面分页仍保留全部历史。自然语言输出不做 JSON 修复。

模型可提交任意工具参数文本，执行函数再使用现有 Zod/服务端合同验证，非法参数返回稳定工具错误。业务读端口只接收服务端绑定的运行输入，身份不能由模型指定。`readBusinessTool` 的实现必须鉴权、按会话关联题目取数，并过滤不必要字段。Skill 首层仅摘要，`load_skill({skill_id})` 才读取注册 ID 的正文；需要正文链接的场景案例时，可传 `reference_id` 单独读取已登记资料。资料沿用 Skill 工作流权限与既有 ReAct 预算，不支持任意路径、远程读取或脚本执行。Tavily 复用每日配额，不增加本次运行的工具次数上限。

`persistMessages` 必须调用已有消息 Repository，按图生成的固定 UUID 幂等写入；用户消息已在发送 API 落库，不重复写。本次不包含 mem0 端口、适配器或运行时；生产部署、完整对话出网、保留期限和旧 `learning_experience_memories` 存量处置均延期到单独决策。

主 Agent 使用 LangChain ChatModel 的单轮 Function Calling，由 LangGraph 控制工具和子 Agent 路由；错题归因和苏格拉底导师分别是固定的独立 Agent 实例。自然语言回复保存在 `responseText`，`pendingQuestion`、`hintLevel`、`verificationTarget`、证据、委派状态和 `tool_call_id` 由 LangGraph State 维护，不从回复文本猜测。

Checkpoint 无法保证模型只收费一次：模型返回后、Checkpoint 保存前崩溃仍可能重发。消息写入使用固定 ID 幂等。队列消费者还必须保证同一会话串行领取，图会拒绝其他未完成运行和过期运行覆盖当前状态。

## 观测与数据库

`0012_learning_assistant_trace_events` 迁移新增 `agent.learning_assistant_trace_events`，关联 `public.learning_assistant_runs`，通过 `span_id`、`parent_span_id`、`agent_name` 展示主工具、子模型和子工具的嵌套关系。实际模型请求与完整返回、工具参数与结果都保存在轨迹中，不写连接密钥。查询端口仅供内部观测使用，不并入公开消息响应。

## 验收与当前边界

当前 LangChain ChatModel、主子 Agent 委派、失败降级、State 版本和控制状态边界有独立合同测试；mem0 尚未装配到学习助手运行。生产级子 Agent 进程中断演练仍需在部署环境补充。

自然语言回复允许自由文本，不通过 JSON Schema 校验。待回答问题、阶段、提示等级和验证目标由服务端状态维护，不从回复文本推测；工具参数、身份、权限、证据来源与持久化仍需严格校验。

本次提供可执行图和 PostgreSQL 运行存储。生产业务取数/记忆验证端口、学习助手内部 API、队列消费装配、观测页面和对话前端仍在后续步骤。现有公开发送消息 API 尚不会自动触发这张图；不能把图的单元/数据库验收当作页面回复链路已经完成。
