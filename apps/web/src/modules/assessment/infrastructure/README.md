# Assessment 基础设施层

`DrizzleAssessmentGenerationContextRepository` 读取目标、学习画像、路线和账户默认模型连接的归属信息；`DrizzleAssessmentQueryRepository` 仅查询题干、选项、标签与分值，刻意不读取答案、解析和评分字段。AgentRun 的创建仍复用 AgentRun 限界上下文的 Drizzle/Outbox 适配器。
