# Assessment 应用层

当前实现 `AssessmentGenerationService`：读取当前用户的学习目标与画像，校验账户默认模型和后测路线归属，并创建 `assessment_generate` AgentRun。前测题量为 10-20 题，后测题量为 5-10 题，难度支持 `normal`/`hard`；题集由 Worker 生成，Web 内部回写接口负责最终落库。

`AssessmentQueryService` 仅允许题集所有者按 Assessment ID 读取作答所需字段，不会返回答案、解析或评分内部数据。

`AssessmentAttemptService` 处理作答提交、评分结果读取和作答历史读取。它不调用模型：题目答案和解析已在生成时保存，仓储在数据库事务中校验完整答案、保存作答并完成确定性评分。前测评分完成后不自动创建路线，仍由用户后续主动触发学习计划生成。
