# Assessment 限界上下文

本上下文负责前测、随堂测验、题目、作答、选择题规则评分与简答题 AI 评分状态。公开响应不得包含隐藏答案、rubric 或模型评分内部元数据。

业务不变量放 `domain`，作答和评分编排放 `application`，存储与 Worker adapter 放 `infrastructure`，外部 DTO 校验放 `interfaces`。
