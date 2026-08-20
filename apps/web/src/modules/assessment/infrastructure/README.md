# Assessment 基础设施层

`DrizzleAssessmentGenerationContextRepository` 读取目标、学习画像、路线和账户默认模型连接的归属信息；`DrizzleAssessmentQueryRepository` 仅查询题干、选项、标签与分值，刻意不读取答案、解析和评分字段。AgentRun 的创建仍复用 AgentRun 限界上下文的 Drizzle/Outbox 适配器。

`DrizzleAssessmentAttemptRepository` 在单个 PostgreSQL 事务中锁定题集、校验答案必须完整且属于对应题目、写入 Attempt/Answer、完成单选题确定性评分并更新题集汇总。它使用 `idempotency_keys` 处理重复点击，不记录模型原文或密钥。
