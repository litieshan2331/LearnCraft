# Profile 限界上下文

本上下文负责当前用户的学习者画像与自定义技术主题学习目标。

- 画像保存整体编程经验、每周可投入时间、内容偏好、设备和可选学习背景；每次更新递增 `profile_version`。
- 创建目标时冻结当前 `profile_version`，可选择当前账户拥有的活跃模型连接覆盖账户默认连接。
- 目标初始状态为 `assessment_pending`；前测 AgentRun 由 Assessment 限界上下文在用户发起前测时创建，Profile 模块本身不直接创建它。
- `POST /api/v1/learning-goals` 强制使用 `Idempotency-Key`，重复点击不会重复创建目标。
- 目标读接口会带出 `latest_plan_run_id` / `latest_assessment_run_id`（该目标上 `queued`/`running` 的生成任务 id，从 `agent_runs` 派生）：
  页面刷新后据此继续显示「前测生成中 / 生成路线中」并接回进度流。`learning_goals.status` 目前只在创建时写入 `assessment_pending`，
  不作为“进行中”状态的来源。

`DELETE /api/v1/learning-goals/{goal_id}` 只允许所有者硬删除目标。目标存在 `queued` 或 `running` AgentRun 时返回 `409 GOAL_HAS_ACTIVE_RUNS`，必须先取消任务；成功删除会级联清理目标业务数据和其 AgentRun 生命周期记录。

分层职责：领域规则和端口在 `domain`，用例在 `application`，Drizzle 实现在 `infrastructure`，Zod/HTTP/presenter 在 `interfaces`，浏览器调用和引导表单在 `presentation`。
