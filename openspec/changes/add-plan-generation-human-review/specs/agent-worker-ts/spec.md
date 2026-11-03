# Spec Delta

## MODIFIED Requirements

### Requirement: AgentRun 生命周期、幂等与重试

AgentRun 执行 SHALL 按“领取运行 → 检查取消 → 按 `run_type` 路由 → 执行工作流 → 回写成功或失败”的顺序进行；支持人工确认的运行还 SHALL 允许在图检查点进入 `waiting_for_human`，结束当前队列任务并在答案提交后以同一运行恢复。终态和等待人工的运行 SHALL 短路重复投递；`retry_count` SHALL 单调不减；成功回写 SHALL 保存工作流真实 token 用量；错误 SHALL 按可重试、不可重试和未分类异常分别执行 BullMQ 重试或最终失败。

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

#### Scenario: 进入人工确认等待
- **WHEN** `plan_generate` 图到达人工确认检查点并生成合法问题批次
- **THEN** 运行以 `waiting_for_human` 状态持久化，当前 BullMQ Job 正常结束且不触发重试
- **AND** 运行保留可恢复 Checkpoint，但不持有 Worker active 槽位、Redis 模型租约或数据库连接

#### Scenario: 人工答案触发恢复
- **WHEN** 当前运行处于 `waiting_for_human` 且服务端已幂等记录完整合法答案
- **THEN** 运行通过 Outbox 进入 `queued`，随后使用同一 `agent_run_id` 和 Checkpoint 恢复执行
- **AND** Worker 从同一 `agent_run_id` 派生原 `thread_id`，并校验 `owner_id`、`goal_id/target_id`、`review_id` 与 Checkpoint 一致
- **AND** 重复答案提交或重复 continuation Job 不重复调用已完成模型步骤

### Requirement: 四类生成工作流保持结构化合同

Worker SHALL 注册并支持 `assessment_generate`、`plan_generate`、`card_content_generate` 和 `posttest_generate` 四类工作流。除 `plan_generate` 外，各工作流 SHALL 保持单一 persona 的 ReAct 会话；`plan_generate` SHALL 使用配置了 PostgreSQL Checkpointer 的 LangGraph 编排人工确认检查点，并在恢复后复用现有路线生成的模型工具调用、严格解析和校验失败自纠逻辑。所有工作流成功后 SHALL 幂等持久化并返回与 Web/Python 兼容的摘要和真实 token 用量。

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

#### Scenario: 路线生成在人工检查点恢复
- **WHEN** `plan_generate` 在人工确认后被重新投递
- **THEN** Worker 使用同一 `agent_run_id` 派生的 `thread_id` 从 PostgreSQL Checkpoint 恢复图状态，把服务端记录的答案加入模型上下文，并继续生成 `learning_plan.v1`
- **AND** 不重新读取或覆盖已经冻结的目标、学习画像和前测输入快照

#### Scenario: 中断节点重放保持幂等
- **WHEN** LangGraph 恢复而重新执行包含 `interrupt()` 的节点
- **THEN** 中断前只允许重复读取和问题构造，路线回写、Outbox、消息和外部调用等副作用必须在恢复后的幂等节点执行
- **AND** Worker 不得使用宽泛 `try/catch` 吞掉 LangGraph 的中断信号

#### Scenario: 恢复值可序列化
- **WHEN** Worker 构造 `interrupt()` payload 或 `Command({ resume })` 值
- **THEN** 值只包含可写入 PostgreSQL Checkpoint 的 JSON 数据
- **AND** 函数、连接、Error、Buffer、循环引用等值被拒绝

#### Scenario: 同一线程恢复加锁
- **WHEN** 多个请求或 Worker 同时尝试恢复同一 `thread_id`
- **THEN** 只有一个执行者可以推进 Checkpoint，其他执行者幂等返回、等待或按退避重试
- **AND** 任何执行者不得绕过线程锁直接调用图

#### Scenario: 路线合同最终校验
- **WHEN** 恢复后的 `plan_generate` 产生路线结果
- **THEN** 结果仍须满足节点数量、`node_key` 唯一、`ordinal` 连续、前置节点存在且依赖图无环
- **AND** 只有通过校验的结果才能调用幂等路线回写接口

### Requirement: Outbox 可靠投递与队列分池

`OutboxDispatcher` SHALL 使用 `FOR UPDATE OF o SKIP LOCKED` 只锁定 Outbox 事件，校验事件版本、载荷和聚合 ID 后投递 BullMQ；投递成功标记 `published`，临时失败按退避标记 `failed`，契约错误或重试耗尽标记 `dead`。已知 `run_type` SHALL 映射到固定资源池：`assessment_generate` 与 `posttest_generate` 使用短任务池，`plan_generate` 与 `card_content_generate` 使用长任务池。人工答案提交产生的 continuation 事件 SHALL 使用同一 AgentRun 的长任务池和幂等约束。

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

#### Scenario: 人工答案事件可靠恢复
- **WHEN** 用户答案已在数据库事务中记录但 Dispatcher 在投递 continuation Job 前停止
- **THEN** Outbox 事件保持可重试状态，恢复后最终投递同一 AgentRun 的 continuation Job
- **AND** 不创建新的 AgentRun 或重复人工确认批次
