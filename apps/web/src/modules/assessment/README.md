# Assessment 限界上下文

本上下文负责前测、路线后测、卡片测验、题目、作答与选择题确定性评分。前测允许用户选择 10–20 题，路线后测允许选择 5–10 题；二者都有 `normal` 和 `hard` 难度卡片，前测按题目顺序逐步增加难度。公开响应不得包含隐藏答案或评分内部元数据。

业务不变量放 `domain`，作答和评分编排放 `application`，存储与 Worker adapter 放 `infrastructure`，外部 DTO 校验放 `interfaces`。当前已实现 `POST /api/v1/learning-goals/{goal_id}/assessment-runs`：它只能创建 `assessment_generate`，通过 Outbox 异步投递，浏览器再轮询 AgentRun 状态；任务成功后使用 `GET /api/v1/assessments/{assessment_id}` 读取不含答案的题集。

已实现前测作答闭环：`POST /api/v1/assessments/{assessment_id}/attempts` 要求一次提交全部选择答案和 UUID 幂等键，在同一事务内保存 `assessment_attempts`、`assessment_answers`，按首次生成时保存的隐藏答案键完成确定性评分，并返回正确答案和解析。`GET /api/v1/assessments/{assessment_id}/attempts` 返回历史摘要，`GET /api/v1/assessment-attempts/{attempt_id}` 仅向作答所有者返回评分详情。P0 的单份前测只允许提交一次；后测重练会创建新的题集和新的作答记录。

节点后测仅依赖对应节点存在 ready CardContent，并绑定 source_card_content_id；节点完成标记只用于个人进度记录，不作为内容或后测的限制条件。
