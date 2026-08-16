# Assessment 应用层

当前实现 `AssessmentGenerationService`：读取当前用户的学习目标与画像，校验账户默认模型和后测路线归属，并创建 `assessment_generate` AgentRun。前测题量为 10-20 题，后测题量为 5-10 题，难度支持 `normal`/`hard`；题集由 Worker 生成，Web 内部回写接口负责最终落库。

`AssessmentQueryService` 仅允许题集所有者按 Assessment ID 读取作答所需字段，不会返回答案、解析或评分内部数据。

后续在此扩展保存答案、执行确定性评分和触发路线调整的用例。
