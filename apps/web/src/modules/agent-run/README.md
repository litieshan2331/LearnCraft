# AgentRun 限界上下文

本上下文负责长任务的创建、状态读取、Outbox 投递与安全失败摘要。它记录 Agent 的执行过程，但不定义学习路线、题目或卡片的业务规则。

AgentRun 状态机与幂等规则放 `domain`，任务投递用例放 `application`，Drizzle/Outbox 适配放 `infrastructure`，公开状态 DTO 与 Route Handler 适配放 `interfaces`。

`AgentRunService.request()` 仅供 Learning Goal、Assessment、Plan 或 Card Content 等受信任的 Web 应用用例调用：每个任务必须携带所属 `goal_id`，它在同一数据库事务中创建 `agent.agent_runs`、首条 `run.queued` 审计事件和 `public.outbox_events` 的 `agent.run.requested` 事件。浏览器没有可自行指定 `run_type` 的通用创建接口。

已提供的浏览器接口为：

- `GET /api/v1/agent-runs/{agent_run_id}`：仅返回当前登录用户拥有的安全状态快照；`assessment_generate` 成功后额外含不泄露题目或答案的 `assessment_result.assessment_id`，供前端读取题集；
- `GET /api/v1/agent-runs/{agent_run_id}/progress`：以 `text/event-stream` 推送该运行的实时进度
  （步骤级与工具级，**不含模型原文**）。这是**临时通道**：事件不落库、不重放，只在生成过程中存在；
  任务归属校验与状态查询一致，订阅不可用时仍返回正常 SSE 流（只发 keep-alive），前端回退到状态轮询。
- `POST /api/v1/agent-runs/{agent_run_id}/cancel`：同源校验后取消 `queued` 或 `running` 任务。取消是协作式的，Worker 会在工作流边界检查 `cancelled` 状态；已经结束的任务返回 `409`，重复取消已取消任务返回当前快照。
