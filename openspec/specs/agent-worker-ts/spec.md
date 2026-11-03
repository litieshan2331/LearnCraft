# Agent Worker TypeScript 规格

## Purpose

定义 `apps/agent-worker-ts` 的运行边界、工作流契约和可靠性不变量，供模型在修改或优化 TypeScript Agent Worker 前快速定位相关代码，并用可验证场景判断行为是否保持兼容。

## Requirements

### Requirement: Worker 分层与进程职责

Agent Worker SHALL 保持应用层、工作流层、接口适配层、基础设施层和启动装配层的依赖方向；业务工作流 SHALL 通过端口访问数据库、模型出网、内部 API、Redis 和工具网关。`worker` 进程 SHALL 消费任务并提供健康/就绪检查，`dispatcher` 进程 SHALL 领取 Outbox 事件并投递队列。

#### Scenario: 修改业务工作流时保持依赖边界

- **WHEN** 修改 `apps/agent-worker-ts/src/workflows/` 中的工作流
- **THEN** 工作流通过注入的端口或依赖访问外部系统，不直接创建 PostgreSQL、Redis、HTTP 或模型 Provider 连接
- **AND** 具体实现仍由 `src/main/worker.ts` 或测试装配

#### Scenario: 进程收到关闭信号

- **WHEN** `worker` 或 `dispatcher` 收到 `SIGTERM` 或 `SIGINT`
- **THEN** 停止领取新任务，等待在飞任务或当前投递批次按既有流程结束，释放未投递事件，关闭健康端点、队列、检查点和连接池
- **AND** 不通过强杀在飞模型请求制造重复业务写入

### Requirement: Outbox 可靠投递与队列分池

`OutboxDispatcher` SHALL 使用 `FOR UPDATE OF o SKIP LOCKED` 只锁定 Outbox 事件，校验事件版本、载荷和聚合 ID 后投递 BullMQ；投递成功标记 `published`，临时失败按退避标记 `failed`，契约错误或重试耗尽标记 `dead`。已知 `run_type` SHALL 映射到固定资源池：`assessment_generate` 与 `posttest_generate` 使用短任务池，`plan_generate` 与 `card_content_generate` 使用长任务池。

#### Scenario: 多 Dispatcher 并发领取

- **WHEN** 多个 Dispatcher 同时领取可投递 Outbox 事件
- **THEN** 每条事件最多由一个实例在同一轮获得处理锁
- **AND** SQL 不得使用会连带锁住 `agent.agent_runs` 的裸 `FOR UPDATE`

#### Scenario: 未知工作流类型

- **WHEN** Outbox 事件的 `run_type` 未配置资源池
- **THEN** 事件仍被投递到短任务池，以便 Worker 将 AgentRun 置为 `AGENT_RUN_WORKFLOW_NOT_REGISTERED` 终态失败
- **AND** 事件不得无限停留在 `pending`

#### Scenario: 投递器优雅关闭

- **WHEN** Dispatcher 在事件已领取但尚未投递时停止
- **THEN** 已领取事件立即回写为可重投的 `failed` 状态，而不是等待锁租约超时

### Requirement: AgentRun 生命周期、幂等与重试

AgentRun 执行 SHALL 按“领取运行 → 检查取消 → 按 `run_type` 路由 → 执行工作流 → 回写成功或失败”的顺序进行。终态运行 SHALL 短路重复投递；`retry_count` SHALL 单调不减；成功回写 SHALL 保存工作流真实 token 用量；错误 SHALL 按可重试、不可重试和未分类异常分别执行 BullMQ 重试或最终失败。

#### Scenario: 重复投递已完成运行

- **WHEN** 同一 `agent_run_id` 的 Job 再次到达且数据库运行已处于终态
- **THEN** 执行器返回 `skipped`，不重复调用模型、不重复写入业务结果

#### Scenario: 可重试模型错误

- **WHEN** 模型网关或内部 API 返回明确的可重试错误且尚未达到最大重试次数
- **THEN** 运行记录下一次 retry，并按 `10/20/40...` 秒退避且封顶 300 秒
- **AND** 队列消费者抛出普通错误交给 BullMQ 重投

#### Scenario: 不可重试或重试耗尽

- **WHEN** 凭据解密错误、未注册工作流、不可重试 Provider 错误或可重试错误达到上限
- **THEN** 运行写入失败终态和稳定错误码，并抛出 `UnrecoverableError` 防止继续重投

### Requirement: 四类生成工作流保持结构化合同

Worker SHALL 注册并支持 `assessment_generate`、`posttest_generate`、`plan_generate` 和 `card_content_generate` 四类工作流。每类工作流 SHALL 读取对应输入快照，使用单一 persona 的 ReAct 会话，在同一消息上下文中执行工具调用、严格解析和校验失败自纠，成功后幂等持久化并返回与 Web/Python 兼容的摘要和真实 token 用量。

#### Scenario: 结构化输出首次校验失败

- **WHEN** 模型返回内容不能通过当前工作流的 Zod 合同
- **THEN** Worker 只把脱敏字段路径作为观察消息追加到同一会话
- **AND** 不重建人格或消息历史，不把模型原文写入公开业务响应

#### Scenario: ReAct 预算耗尽

- **WHEN** 工作流达到注入的 ReAct 模型调用次数上限仍未得到合法输出
- **THEN** 工作流以稳定的不可重试错误结束，并由任务级失败策略处理

#### Scenario: 工具调用预算达到上限

- **WHEN** 单次运行已达到可见联网工具调用上限
- **THEN** 后续模型轮次不再提供工具，要求模型基于已有资料完成结构化回答

### Requirement: 受控模型出网与凭据保护

模型请求 SHALL 只能通过 `src/infrastructure/llm/` 的凭据解密、出网策略、安全传输和模型网关完成。生产出网 SHALL 校验 HTTPS/端口、禁止 userinfo/相对路径/IP 字面量/本地域名、校验 DNS 全部结果并固定连接地址；请求 SHALL 使用原域名 SNI 与证书校验、禁止重定向、限制解压后响应体并在审计写入失败时 fail-closed。密钥和明文凭据 SHALL 不进入日志、轨迹或队列载荷。

#### Scenario: 出网审计不可写

- **WHEN** 模型请求前无法写入 `model_connection_egress_audits`
- **THEN** 安全出网客户端拒绝发出 Provider 请求

#### Scenario: Provider 返回 SSE

- **WHEN** 模型网关接收流式响应
- **THEN** 只接受符合 SSE 结构和大小限制的响应，合并工具调用分片和文本结果，并按错误类型执行既定退避

### Requirement: 学习助手 LangGraph 运行约束

学习助手 SHALL 使用可恢复的 LangGraph.js 图：主 Agent 可串行调用错题归因和苏格拉底导师子 Agent；业务查询、Skill 和 Tavily 工具必须通过白名单端口。运行输入 SHALL 固定本次运行的模型连接；Checkpoint、消息、学习记忆和轨迹写入 SHALL 幂等，并按 `conversation_id` 与 `run_id` 防止并发运行覆盖。

#### Scenario: 恢复已有 Checkpoint

- **WHEN** 学习助手运行重试或进程恢复且已有 Checkpoint
- **THEN** 使用保存的连接快照和最近 20 个用户轮的完整工具链继续执行
- **AND** 不重新选择用户当前默认连接，不重复加载全部历史

#### Scenario: 学习记忆候选写入

- **WHEN** 子 Agent 生成学习记忆候选
- **THEN** 服务端重新核对证据来源和后续表现后才允许幂等写入
- **AND** 口头确认或模型自评不得直接改变学习者画像或掌握度

### Requirement: 教学 Skill 渐进式加载

Worker SHALL 只从 `apps/agent-worker-ts/Skills/index.json` 读取 Skill 摘要进行初始选择；选定 Skill 后再读取对应 `SKILL.md`，必要时按已登记 ID 读取单份 `references/` 文件。加载器 SHALL 拒绝任意路径、符号链接越界、远程读取和脚本执行，并遵守工作流白名单和既有 ReAct 预算。

#### Scenario: 请求未登记的 Skill

- **WHEN** 模型通过 `load_skill` 请求不存在或不适用于当前工作流的 Skill/参考资料
- **THEN** 工具返回受控不可用结果，不读取任意文件，不泄露文件系统异常细节

#### Scenario: 修改 Skill 内容

- **WHEN** 修改 Skill 的名称、描述、适用工作流或参考资料
- **THEN** 同步更新 `SKILL.md`、`Skills/index.json` 和 `Skills/README.md`，并运行对应格式与 Worker 测试校验

### Requirement: 运行配置、观测和验证

并发、超时、重试、队列、出网、工具和 ReAct 限额 SHALL 通过环境变量解析为经过校验的配置，不得在业务代码中硬编码。Worker SHALL 提供 `/health` 和 `/ready`，实时进度 SHALL 只发送允许的步骤/工具元数据到临时 Redis 频道；完整模型和工具轨迹 SHALL 留在内部观测存储，不进入公开消息响应。

#### Scenario: 配置非法或依赖不可用

- **WHEN** 必填环境变量缺失、配置违反边界或数据库/队列 Redis 就绪检查失败
- **THEN** 进程启动失败或就绪探针失败，并输出不含密钥的错误信息

#### Scenario: 修改跨层 Worker 行为

- **WHEN** 修改工作流装配、队列协议、数据库状态机、出网策略或学习助手图
- **THEN** 至少运行 `pnpm --filter @learncraft/agent-worker-ts typecheck` 与相关单元测试；涉及入口或打包时额外运行 `pnpm --filter @learncraft/agent-worker-ts build`
- **AND** 涉及真实数据库、Redis 或 Provider 的验证必须显式使用集成测试开关，不得默认产生真实写入或费用
