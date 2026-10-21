# 学习助手对话图

这里实现独立的 LangGraph.js 对话图，主 Agent 将错题归因与苏格拉底导师当作两个工具调用。子 Agent 可以调用业务读工具、Skill 与共享 Tavily 网关，工具白名单不包含继续委派。四个既有生成工作流继续使用原执行器。

## 文件与调用顺序

- `index.ts`：装配出口。
- `graph.ts`：编译主图、检查运行身份与固定连接、恢复同一运行。
- `state.ts`：可序列化状态、消息幂等合并、20 轮模型窗口。
- `ports.ts`：模型、可信取数、消息持久化、记忆验证等依赖合同。
- `agents/main-agent.ts`：主 Agent 的工具路由与最终回复校验。
- `agents/error-attribution-agent.ts`：错题归因子 Agent 的模型入口与归因合同校验。
- `agents/socratic-tutor-agent.ts`：苏格拉底导师子 Agent 的模型入口、单问题与提示等级校验。
- `agents/shared.ts`：共用模型调用、预算、轨迹、消息标识和子模型循环；`agents/index.ts` 只重新导出。
- `nodes/load-context-node.ts`、`tool-nodes.ts`、`persist-nodes.ts`：分别负责上下文准备、串行工具执行、消息与学习经历持久化。
- `tools/index.ts`：业务查询、动态 Skill、Tavily、两个子 Agent 的工具定义。
- `prompts/main-agent-prompt.ts`、`error-attribution-prompt.ts`、`socratic-tutor-prompt.ts`：每个 Agent 各自完整维护七节提示词、可信上下文、输出合同和示例。
- `prompts/validation-feedback.ts`：主 Agent 和子 Agent 共用的一次性结构化输出修复反馈。
- `schemas/index.ts`：运行输入、输出、证据、主要问题等 Zod 合同。
- `../../infrastructure/database/learning-assistant-runtime-store.ts`：独立轨迹、原子模型调用计数、内部分页查询。

```text
START → prepare → main
                  ├→ main_tool → child_model ↔ child_tool
                  │      ↑             │
                  │      └─────────────┘
                  │      └→ 下一个 main_tool / main
                  └→ persist → memory → END
```

主工具每次执行一个；每个子模型和子工具也有独立 Checkpoint。子内部消息保存在图状态与完整轨迹中，主模型只接收其结构化结果。正常追问在本轮 `END`，下一用户消息沿用同一 `thread_id = conversation_id`，不使用人工审批式中断。

## 装配约定

先创建 `createLearningAssistantCheckpointer(databaseUrl)` 和 `PgLearningAssistantRuntimeStore(pool)`，再注入 `LearningAssistantDependencies`，调用 `createLearningAssistantGraph(deps)`、`runLearningAssistant(graph, deps, input)`。

`connection` 必须是该用户本次运行确定的有效默认连接；`input` 只保存连接 ID、模型 ID，不保存密钥。恢复时按本次运行保存的连接快照重新装配，不能重新选择用户此刻的默认连接。网关通过请求级 `traceWriter` 使用学习助手轨迹，避免写到旧 `agent_runs` 外键。调用网关的 `beforeModelAttempt` 在每次实际尝试之前原子记录调用计数。主 Agent、归因子 Agent、导师子 Agent 分别使用服务端装配的 ReAct 轮数上限（默认 6/4/4），上限保存在 Checkpoint；工具不会因为接近上限而被主动撤掉，提示词负责引导模型输出最终结构，图条件边负责停止回环。

`loadInitialMessages` 仅在没有已初始化的 Checkpoint 时读取业务历史。之后模型消息来源为 Checkpoint，每次只取最近 20 个用户轮，包含当前轮并保留该轮完整工具链。业务消息表和页面分页仍保留全部历史。内部输出修复反馈不作为真实用户消息落库，也不会在后续轮次的模型上下文中重复出现。

业务读端口只接收服务端绑定的运行输入，模型只能传空参数；子 Agent 工具只传任务描述。`readBusinessTool` 的实现必须鉴权、按会话关联题目取数，并过滤不必要字段。Skill 首层仅摘要，`load_skill({skill_id})` 才读取注册 ID 的正文；需要正文链接的场景案例时，可传 `reference_id` 单独读取已登记资料。资料沿用 Skill 工作流权限与既有 ReAct 预算，不支持任意路径、远程读取或脚本执行。Tavily 复用每日配额，不增加本次运行的工具次数上限。

`persistMessages` 必须调用已有消息 Repository，按图生成的固定 UUID 幂等写入；用户消息已在发送 API 落库，不重复写。`persistLearningMemory` 使用本 run 的固定幂等标识。`validateLearningMemory` 必须在服务端重新核对证据来源与用户后续表现，不可只相信子模型返回的 `verified`。口头确认不能写入，未实际运行代码只能保存为模型评估，不直接改画像或掌握度。正式运行完成由后续消费处理器调用已有 RunRepository，不可覆盖数据库已累计的请求次数和 token。

Checkpoint 无法保证模型只收费一次：模型返回后、Checkpoint 保存前崩溃仍可能重发。已保存的模型/工具结果会被恢复复用；消息和记忆端口必须幂等。队列消费者还必须保证同一会话串行领取，图会拒绝其他未完成运行和过期运行覆盖当前状态。

## 观测与数据库

`0012_learning_assistant_trace_events` 迁移新增 `agent.learning_assistant_trace_events`，关联 `public.learning_assistant_runs`，通过 `span_id`、`parent_span_id`、`agent_name` 展示主工具、子模型和子工具的嵌套关系。实际模型请求与完整返回、工具参数与结果都保存在轨迹中，不写连接密钥。查询端口仅供内部观测使用，不并入公开消息响应。

## 验收与当前边界

单元测试使用真实 LangGraph + 假模型，覆盖自主工具路由、串行双子 Agent、子工具权限、证据伪造、单问题检查、一次修复、20 轮窗口、提示升级、换题重置、幂等记忆及节点恢复。真实 PostgreSQL 用例覆盖重建图恢复、并发调用计数、嵌套轨迹、全部业务消息及级联删除，不请求付费模型。

主要问题的结构、问号与常见并列子问可程序检查；自然语言中所有语义复合问题不能仅靠 Zod 保证，需结合七节提示词与实际对话验收。

本次提供可执行图和 PostgreSQL 运行存储。生产业务取数/记忆验证端口、学习助手内部 API、队列消费装配、观测页面和对话前端仍在后续步骤。现有公开发送消息 API 尚不会自动触发这张图；不能把图的单元/数据库验收当作页面回复链路已经完成。
