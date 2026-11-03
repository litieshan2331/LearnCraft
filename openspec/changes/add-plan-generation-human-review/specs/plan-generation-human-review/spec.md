# Spec Delta

## Purpose

为学习路线生成提供可恢复的人工确认能力，使模型能够基于完整结构化学习上下文提出有限、可操作的问题，并在用户选择后继续生成更符合目标、画像和学习偏好的路线。该能力同时定义公开状态、答案安全边界和等待期间的资源释放行为。

## ADDED Requirements

### Requirement: 生成结构化人工确认问题

启用 Human-in-the-Loop 的学习路线生成 SHALL 固定进入人工确认阶段；模型 SHALL 仅基于服务端冻结的目标、学习画像、前测结果和已有路线生成上下文生成 1–3 个问题，应用代码 SHALL 在校验通过后调用中断。每个问题 SHALL 恰好包含 3 个选项，其中第三个选项 SHALL 支持用户输入自定义文本。

#### Scenario: 生成可回答的问题批次
- **WHEN** `plan_generate` 已加载完整结构化输入且进入人工确认阶段
- **THEN** 系统返回 1–3 个问题，每个问题包含稳定的 `question_id`、面向用户的文本和恰好 3 个稳定的 `option_id`
- **AND** 每个问题的第三个选项标记为 `custom_text`，并包含自定义文本的长度边界
- **AND** 问题和选项不包含 API Key、内部提示词、工具载荷或模型原始思考
- **AND** 是否调用 `interrupt()` 不由模型输出的控制字段决定，而由应用流程固定决定

#### Scenario: 模型问题输出不符合合同
- **WHEN** 模型返回的问题数量不在 1–3 范围内、选项数量不等于 3、ID 重复或文本超出边界
- **THEN** 系统不得向用户展示该批次，并按结构化输出错误处理当前 AgentRun
- **AND** 内部轨迹记录脱敏字段路径，不记录凭据或公开响应中的模型原文

### Requirement: 公开展示待确认状态

系统 SHALL 为同时通过所有者、目标、AgentRun 和 LangGraph thread 绑定校验的请求公开 `waiting_for_human` AgentRun 状态及安全的人工确认快照；快照 SHALL 只包含问题、选项、运行标识、版本和可选过期时间，不得返回完整 Checkpoint、输入快照、提示词、工具结果或思考原文。客户端不得指定 thread ID。

#### Scenario: 查询等待中的路线生成
- **WHEN** 任务已在 LangGraph 检查点暂停并进入 `waiting_for_human`
- **THEN** AgentRun 查询返回该状态和未回答的问题批次
- **AND** 同一用户刷新页面后仍能恢复并展示相同的问题顺序与选项

#### Scenario: 线程绑定不匹配
- **WHEN** 请求对应的 `owner_id` 正确，但 AgentRun、目标、人工确认记录或服务端派生的 LangGraph `thread_id` 与 Checkpoint 不一致
- **THEN** 系统拒绝读取或恢复人工确认，并返回统一的未找到、无权或状态冲突错误
- **AND** 不创建新线程、不切换到其他 Checkpoint、不泄露问题内容

#### Scenario: 非任务拥有者读取待确认状态
- **WHEN** 其他用户使用运行 ID 查询或提交人工确认
- **THEN** 服务端返回统一的未找到或无权错误
- **AND** 不泄露目标、问题文本、选项或运行是否存在

### Requirement: 人工等待不占用执行资源

AgentRun 进入 `waiting_for_human` 后 SHALL 结束当前 BullMQ Job 的执行并释放 Worker active 槽位、Redis 模型租约和数据库连接；等待期间 SHALL 保留可恢复的图检查点和业务运行状态。

#### Scenario: 图在人工节点暂停
- **WHEN** LangGraph 到达人工确认节点并触发中断
- **THEN** Worker 将运行状态更新为 `waiting_for_human` 后正常结束当前 Job
- **AND** 不触发 BullMQ 重试，不继续发起模型请求，不持有模型并发许可

#### Scenario: 等待期间服务重启
- **WHEN** Worker 在运行处于 `waiting_for_human` 时重启
- **THEN** 系统不重复执行已完成的模型步骤，也不自动创建新的模型请求
- **AND** 用户提交答案后可以从同一检查点继续执行

### Requirement: Checkpoint 与恢复线程保持一致

人工中断 SHALL 只运行在配置了 PostgreSQL Checkpointer 的 LangGraph 图中；启动、重试和恢复 MUST 使用同一个由业务运行主键派生的 `thread_id`，并在恢复前校验所有者、目标、AgentRun、review 和 Checkpoint 的业务绑定。

#### Scenario: 未配置 Checkpointer
- **WHEN** Worker 尝试启用学习路线人工中断但图未配置 PostgreSQL Checkpointer
- **THEN** Worker 拒绝启动该能力或将运行安全失败
- **AND** 系统不得使用进程内等待、伪造 Checkpoint 或继续调用模型

#### Scenario: 使用原线程恢复
- **WHEN** 用户提交合法答案并创建 continuation Job
- **THEN** Worker 使用与首次执行完全相同的 `thread_id` 调用 LangGraph 恢复
- **AND** LangGraph 回到原人工中断点，不创建新线程

#### Scenario: 业务上下文不匹配
- **WHEN** `thread_id` 存在但当前 actor、目标、AgentRun、review、图版本或 Checkpoint 绑定不匹配
- **THEN** 系统拒绝恢复并保持原状态
- **AND** 不调用模型、不写答案、不创建 continuation Job

### Requirement: 中断节点重放和恢复输入可安全持久化

人工中断节点在 `interrupt()` 前 SHALL 只执行可重复的读取和问题构造；不可幂等副作用 SHALL 放在恢复后的独立节点。中断 payload 与 resume 值 MUST 是可序列化 JSON，且系统不得吞掉 LangGraph 中断信号。

#### Scenario: 中断节点发生重放
- **WHEN** LangGraph 因恢复重新执行包含 `interrupt()` 的节点
- **THEN** 中断前的读取和问题构造可以重复执行而不产生重复业务写入或外部调用
- **AND** 路线持久化、消息发送和 Outbox 等副作用只在恢复后的幂等节点执行

#### Scenario: 中断 payload 不可序列化
- **WHEN** 问题 payload 或 resume 值包含函数、连接、Error、循环引用或其他非 JSON 值
- **THEN** 系统在进入中断或恢复前拒绝该数据并记录稳定结构化错误
- **AND** 不写入不可恢复的 Checkpoint

#### Scenario: 单中断恢复协议
- **WHEN** 当前图只有一个人工中断点且用户提交一个完整答案
- **THEN** Worker 使用单值 `Command({ resume: answer })` 或等价统一恢复协议
- **AND** 恢复结果经过问题 ID、选项 ID 和业务上下文校验

#### Scenario: 多中断恢复协议
- **WHEN** 未来同一超步包含多个并行中断
- **THEN** Worker 使用中断 ID 到答案的映射恢复，并稳定维护同一节点多个中断的调用顺序
- **AND** 不把多个答案按不确定的并行顺序写入不同问题

### Requirement: 同一线程恢复必须串行

系统 SHALL 对同一 `thread_id` 的人工答案提交和 continuation 执行加互斥控制；并发恢复请求中只有一个可以推进 Checkpoint，其他请求必须幂等返回或等待后读取最新状态。

#### Scenario: 并发点击恢复
- **WHEN** 同一用户快速提交相同答案或两个 Worker 同时处理同一 continuation Job
- **THEN** 只有一个请求推进图并创建有效的后续执行
- **AND** 其他请求不重复调用模型、不覆盖答案、不产生第二个线程

#### Scenario: 线程锁超时
- **WHEN** 获取同一 `thread_id` 的恢复锁超过配置时限
- **THEN** 系统返回可重试的稳定错误或让队列按既有退避重试
- **AND** 不绕过锁直接执行图

### Requirement: 幂等提交人工答案并恢复运行

系统 SHALL 提供同时受所有者、目标、AgentRun、review ID 和服务端派生 thread ID 保护的人工答案提交操作；答案 MUST 引用服务端返回的问题和选项 ID，第三个选项可携带受长度限制的自定义文本。相同幂等键重复提交 SHALL 返回同一恢复结果，不得创建重复 continuation Job；请求不得让客户端覆盖 thread ID。

#### Scenario: 用户提交完整答案
- **WHEN** 运行处于 `waiting_for_human` 且所有问题均提交合法选项
- **THEN** 系统在事务中记录答案，将运行转为 `queued`，并通过 Outbox 可靠投递同一 AgentRun 的 continuation Job
- **AND** 后续图执行使用同一 Checkpoint、同一模型连接快照和本次答案继续运行
- **AND** 后续图执行使用同一 `agent_run_id` 派生出的原 `thread_id`，不得新建线程或复用其他运行的线程

#### Scenario: 重复点击提交
- **WHEN** 用户使用相同幂等键重复提交同一答案
- **THEN** 系统返回已记录的答案和运行状态
- **AND** 不重复写入答案、不重复投递 Job、不重复调用模型

#### Scenario: 答案非法或过期
- **WHEN** 提交缺少问题、选项不属于当前批次、自定义文本超长、运行已恢复或人工确认已过期
- **THEN** 系统拒绝提交并返回稳定错误码
- **AND** 原运行状态、Checkpoint 和已记录答案保持不变

#### Scenario: 仅所有者相同但线程不一致
- **WHEN** 提交方属于正确所有者，但答案关联的 review 或服务端解析出的 thread ID 不属于该 AgentRun 的当前 Checkpoint
- **THEN** 系统拒绝提交并保持原运行状态
- **AND** 不写入答案、不创建 continuation Job、不调用模型

### Requirement: 使用人工答案生成并持久化学习路线

恢复后的路线生成 SHALL 将已确认答案作为版本化结构化上下文交给模型，并继续执行现有路线合同校验、工具预算、错误分类和幂等回写；成功结果 SHALL 仍符合 `learning_plan.v1` 的节点数量、编号、依赖和无环约束。

#### Scenario: 用户答案影响路线生成
- **WHEN** continuation Job 从人工检查点恢复
- **THEN** 模型输入包含原始结构化学习上下文和服务端记录的人工答案
- **AND** 生成结果经过现有严格校验后才允许写入学习路线

#### Scenario: 恢复后模型输出校验失败
- **WHEN** 恢复后的模型输出不符合 `learning_plan.v1`
- **THEN** 系统按既有 ReAct 自纠和重试策略处理
- **AND** 不生成半成品路线，不改变已保存的人工答案

### Requirement: 页面支持人工确认和恢复

学习路线生成页面 SHALL 展示等待状态和问题选项，支持每题选择一个选项及第三项自定义文本；提交期间 SHALL 禁止重复提交，刷新后 SHALL 从 AgentRun 状态恢复问题和选择结果。

#### Scenario: 页面展示人工确认
- **WHEN** 页面轮询到 `waiting_for_human`
- **THEN** 页面停止普通生成进度提示并展示 1–3 个问题及每题 3 个选项
- **AND** 用户选择第三项时可以输入文本，输入不满足长度边界时页面阻止提交

#### Scenario: 提交后继续生成
- **WHEN** 用户完成所有问题并提交
- **THEN** 页面显示已提交和继续生成状态，不能再次提交同一批次
- **AND** 运行成功后跳转到新生成的学习路线，失败时展示安全错误文案
