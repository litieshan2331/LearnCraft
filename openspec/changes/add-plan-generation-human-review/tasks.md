# Tasks

## 1. 运行状态、数据合同与持久化基础

- [x] 1.1 将 `agent_runs` 的 `waiting_for_human` 加入 Web/Worker 领域状态、数据库约束、目标级在途查询、取消和删除保护；执行数据库迁移并用 `pnpm db:check` 验证迁移和状态约束。
- [x] 1.2 增加人工确认记录的表结构或等价持久化适配，保存问题快照、答案、版本、状态、过期时间和幂等键，并实现按 `agent_run_id` 和所有者读取；用 Repository 单元测试验证重复写入、跨用户读取和输入快照不可变。
- [x] 1.3 定义人工问题批次、问题选项、自定义文本答案和公开 AgentRun 快照的 Zod/OpenAPI 合同；用 schema 测试覆盖 1–3 个问题、每题恰好 3 个选项、重复 ID、超长文本和敏感字段拒绝。
- [x] 1.4 更新 AgentRun Presenter、规划领域客户端类型和目标读接口，使 `waiting_for_human` 被视为在途状态且只公开白名单字段；运行 Web 相关 presenter、领域和契约测试确认不暴露 Checkpoint、提示词或模型原文。

## 2. LangGraph 学习路线人工检查点

- [x] 2.1 在 `plan-generate` 工作流中增加独立的 LangGraph state、thread 配置和 PostgreSQL Checkpoint 装配，确保首次执行、队列重试、Worker 重启和人工恢复始终使用同一 `agent_run_id` 派生的 `thread_id`，并校验 `owner_id`、目标和 Checkpoint 绑定；确保 Checkpoint 不保存 API Key、解密凭据或不受限的请求头；用 MemorySaver/隔离 PostgreSQL 测试验证线程一致性。
- [x] 2.2 实现完整输入快照到人工问题生成节点的提示词和结构化解析，限制问题数为 1–3、每题选项数为 3，并固定第三项为 `custom_text`；用假模型测试合法输出、结构化错误和字段路径脱敏。
- [x] 2.3 实现 `interrupt` 暂停、可识别暂停结果和 AgentRun 状态转换；验证暂停后 BullMQ Job 正常结束、不触发重试、不继续调用模型，并释放 Worker 槽位、Redis 许可和数据库连接。
- [x] 2.4 将现有 `runReactAgentSession` 接入恢复后的路线生成节点，合并服务端人工答案并继续 `learning_plan.v1` 校验与幂等回写；确保 `interrupt()` 前无不可幂等副作用且不吞中断信号；运行现有 `plan-generate` 单元测试并新增节点重放、恢复后输出影响和路线合同测试。
- [x] 2.5 实现答案版本校验、`Command({ resume })` 或等价统一恢复入口、2 小时可配置过期/取消处理和图版本兼容；用测试覆盖单中断单值恢复、未来多中断 ID 映射协议、JSON 序列化拒绝、Worker 重启、重复 continuation Job、旧 Checkpoint 和非法答案不会重复调用已完成步骤。
- [x] 2.6 为同一 `thread_id` 增加数据库 advisory lock 或等价互斥控制，设置获取锁超时并按队列退避；用并发测试验证两个恢复请求只有一个推进 Checkpoint，锁超时不会绕过互斥直接调用图。

## 3. API、Outbox 与队列恢复

- [x] 3.1 新增所有者、目标、AgentRun 和服务端派生 thread 绑定保护的人工确认查询和提交 API，客户端不得提交 thread ID；提交接口校验 `review_id`、问题/选项 ID、答案完整性和自定义文本边界；用 Web Route 测试覆盖未登录、跨用户、跨目标、线程不一致、非法选项、缺题和过期场景。
- [x] 3.2 在答案提交事务中写入人工确认、将运行从 `waiting_for_human` 转为 `queued` 并创建 continuation Outbox 事件；用事务/Repository 测试验证相同幂等键不重复写答案、不重复创建事件和不覆盖原始输入快照。
- [x] 3.3 让 Outbox Dispatcher 和 Worker 识别 continuation 载荷，继续使用 `plan_generate` 长任务池和原运行 ID；运行 Dispatcher 并发、投递失败重试、Worker 重复领取和答案提交后恢复测试。
- [x] 3.4 同步 OpenAPI、内部错误码、进度状态和取消接口文案，更新 API README 说明状态流转、公开字段和幂等行为；用 OpenAPI 校验和 Markdown 代码块/链接检查验证文档一致性。

## 4. 学习路线页面交互

- [x] 4.1 更新规划客户端和 `PlanGenerationAction`，轮询并展示 `waiting_for_human` 问题批次，支持每题单选、第三项自定义文本、提交中禁用和安全错误提示；用组件测试验证问题数量、选项数量和输入边界。
- [x] 4.2 实现刷新恢复、已提交状态、过期、取消、网络重试和生成成功跳转；用组件/API 测试验证刷新不会重新创建 AgentRun，重复点击复用幂等键，成功后只跳转一次。
- [x] 4.3 更新学习路线模块 README 和实施链路文档，说明用户等待期间不占用 Worker/Provider 许可及本地启动配置；按文档命令进行静态检查并确认示例请求与 OpenAPI 一致。

## 5. 隔离集成与验收

- [ ] 5.1 增加隔离 PostgreSQL、Redis、Dispatcher、Worker 和假模型的集成 fixture，覆盖“创建路线 → 问题暂停 → 页面/接口提交答案 → continuation → 路线回写”；验证默认不调用真实 Provider、不写入非测试数据。
- [ ] 5.2 增加故障场景测试：暂停后 Worker 重启、答案提交后 Dispatcher 停止、重复提交、模型结构化错误、路线校验失败、人工过期和取消；验证最终状态、Checkpoint、Outbox 和业务回写保持幂等。
- [ ] 5.3 增加资源边界测试，确认 `waiting_for_human` 期间没有长期 BullMQ active Job、Redis 模型租约或 PostgreSQL 长连接，并验证长任务不会阻塞短任务池；输出可审计的测试日志和指标。
- [ ] 5.4 运行最小完整验证：`pnpm --filter @learncraft/agent-worker-ts typecheck`、相关 Worker 测试、`pnpm --filter @learncraft/agent-worker-ts build`、Web lint/typecheck/相关测试、`pnpm db:check`、OpenAPI 校验和 `openspec validate add-plan-generation-human-review --strict`；检查 `git diff --check` 与敏感信息。

## Workflow follow-up

- 评审并确认所有规划工件及数据库状态/人工确认持久化方案后，再运行 `$openspec-apply-change` 开始实现。
- 实现和验收完成后，运行 `$openspec-archive-change` 归档变更并同步正式规格。
