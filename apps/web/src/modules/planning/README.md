# Planning 限界上下文

本上下文负责学习目标、路线版本、路线节点、前置依赖与可解释的路线调整。Python Worker 只能通过内部契约提交校验后的生成结果，不能直接写入本上下文的业务表。

`domain` 维护路线不变量；`application` 组织创建目标和请求生成路线等用例；`infrastructure` 提供 Drizzle repository、Outbox 与 Worker HTTP adapter；`interfaces` 只处理边界输入输出。

路线生成成功后，`GET /api/v1/learning-plans/{plan_id}` 返回按 ordinal 排序的章节目录，`GET /api/v1/plan-nodes/{node_id}` 返回单章节详情；查询仓储始终按 Session 所有者过滤。`/learning-plans/{plan_id}` 页面使用同源客户端展示书籍章节式路线。

启用 Human-in-the-Loop 的 `plan_generate` 会在路线生成前固定进入人工确认阶段：AgentRun 状态变为 `waiting_for_human`，公开任务快照只返回 1–3 个问题及每题三个选项，第三项支持自定义文本。用户通过 `POST /api/v1/agent-runs/{agent_run_id}/human-review` 提交完整答案，服务端使用同一 AgentRun、同一 LangGraph `thread_id` 和幂等键重新投递 continuation；人工等待期间不占用 Worker active 槽位、模型租约或数据库连接。客户端不得提交 thread ID，服务端会校验所有者、目标、review 和 Checkpoint 绑定。
