# Profile 限界上下文

本上下文负责当前用户的学习者画像与自定义技术主题学习目标。

- 画像保存整体编程经验、每周可投入时间、内容偏好、设备和可选学习背景；每次更新递增 `profile_version`。
- 创建目标时冻结当前 `profile_version`，可选择当前账户拥有的活跃模型连接覆盖账户默认连接。
- 目标初始状态为 `assessment_pending`；本模块不提前创建尚未实现的前测 AgentRun。
- `POST /api/v1/learning-goals` 强制使用 `Idempotency-Key`，重复点击不会重复创建目标。

分层职责：领域规则和端口在 `domain`，用例在 `application`，Drizzle 实现在 `infrastructure`，Zod/HTTP/presenter 在 `interfaces`，浏览器调用和引导表单在 `presentation`。
