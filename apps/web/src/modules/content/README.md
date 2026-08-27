# Content 限界上下文

本上下文负责受控资料、内容分块、检索引用与学习卡片内容。实战或调试卡片的 Demo 必须由受控流程预运行成功后才能发布。

资料与卡片规则放 `domain`，请求内容生成与读取放 `application`，Drizzle/对象存储/检索适配放 `infrastructure`，外部输入输出放 `interfaces`。

已实现 `POST /api/v1/plan-nodes/{node_id}/content-runs`：它只为当前有效路线中的节点创建 `card_content_generate` AgentRun，并冻结目标、画像和节点摘要；Worker 已注册 NodeTutorAgent 与 card_content_generate 工作流，并通过内部 card-content-result 接收校验后的内容；内容阅读查询接口将在后续步骤接入。
