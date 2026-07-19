# AgentRun 限界上下文

本上下文负责长任务的创建、状态读取、Outbox 投递与安全失败摘要。它记录 Agent 的执行过程，但不定义学习路线、题目或卡片的业务规则。

AgentRun 状态机与幂等规则放 `domain`，任务投递用例放 `application`，Drizzle/Outbox/内部 HTTP 适配放 `infrastructure`，公开状态 DTO 放 `interfaces`。
