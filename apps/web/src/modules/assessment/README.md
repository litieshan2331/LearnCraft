# Assessment 限界上下文

本上下文负责前测、路线后测、卡片测验、题目、作答与选择题确定性评分。前测允许用户选择 10–20 题，路线后测允许选择 5–10 题；二者都有 `normal` 和 `hard` 难度卡片，前测按题目顺序逐步增加难度。公开响应不得包含隐藏答案或评分内部元数据。

业务不变量放 `domain`，作答和评分编排放 `application`，存储与 Worker adapter 放 `infrastructure`，外部 DTO 校验放 `interfaces`。当前已实现 `POST /api/v1/learning-goals/{goal_id}/assessment-runs`：它只能创建 `assessment_generate`，通过 Outbox 异步投递，浏览器再轮询 AgentRun 状态；任务成功后使用 `GET /api/v1/assessments/{assessment_id}` 读取不含答案的题集。按学习目标查看历史题集的接口保留至 P1。
