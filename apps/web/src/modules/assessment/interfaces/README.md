# Assessment 接口层

包含前测/后测题量与难度的 Zod 校验、题集参数校验和稳定错误响应。公开接口为 `POST /api/v1/learning-goals/{goal_id}/assessment-runs`；返回的 AgentRun 使用 `GET /api/v1/agent-runs/{agent_run_id}` 轮询，成功后从 `assessment_result.assessment_id` 跳转到 `GET /api/v1/assessments/{assessment_id}`。题集响应不包含答案或解析。

作答接口使用 `assessment-attempt-schemas.ts` 校验题目 ID、选项和重复答案；`POST /api/v1/assessments/{assessment_id}/attempts` 必须携带 UUID 格式 `Idempotency-Key` 和同源 `Origin`。成功响应才经 `assessment-attempt-presenter.ts` 返回答案、解析和评分；历史摘要与详情均按 Session 所有者鉴权。
