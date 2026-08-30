# Web API 路由边界

本目录放置 `/api/v1` 的 Next.js Route Handler。Route Handler 只负责提取 Session、使用 Zod 校验输入、调用 application 用例并映射 HTTP 响应；不得直接编写领域规则、SQL 或模型调用。

当前已实现无需登录的 `GET /api/v1/health` 与 `GET /api/v1/version`；经 Session 鉴权的学习画像读取与保存、学习目标创建与读取、用户模型连接的列表/创建/更新/删除/设为默认、assessment_generate AgentRun 创建、AgentRun 状态读取/取消及单个题集读取接口。学习目标与 assessment_generate 创建都必须携带 UUID 格式的 `Idempotency-Key`，相同键的安全重试不会重复创建资源。assessment_generate 只能通过学习目标业务路由创建，前测题量为 10-20 题，后测为 5-10 题；成功后从 AgentRun 的 `assessment_result.assessment_id` 读取题集。题集接口不会返回答案、解析或评分内部字段；按学习目标读取历史题集保留至 P1。模型连接只支持 OpenAI-compatible 协议，响应永远不返回 API Key、密文、IV 或认证标签。健康检查当前只验证 Web 进程与基础运行时，数据库与外部服务的就绪检查将在 Docker Compose 接入后补充。

前测题集生成后，`GET /api/v1/assessments/{assessment_id}` 仍只返回题干和选项。用户必须通过 `POST /api/v1/assessments/{assessment_id}/attempts` 一次提交完整答案并携带 UUID `Idempotency-Key`；服务端同步完成确定性评分，成功响应才返回正确答案和解析。`GET /api/v1/assessments/{assessment_id}/attempts` 返回当前题集的作答摘要，`GET /api/v1/assessment-attempts/{attempt_id}` 返回仅作答所有者可见的评分详情。

学习路线生成成功后，`GET /api/v1/learning-plans/{plan_id}` 返回书籍章节式路线目录，`GET /api/v1/plan-nodes/{node_id}` 返回单个章节详情；两者都按 Session 所有权过滤。路线展示页面位于 `/learning-plans/{plan_id}`。

`POST /api/v1/plan-nodes/{node_id}/content-runs` 使用 UUID `Idempotency-Key` 创建节点知识内容任务，仅允许当前有效路线中尚无成功内容的节点发起；Worker 会异步执行 Node Tutor 并回写内容状态。

具体接口字段以 `packages/contracts/openapi/core.yaml` 为准。

生成节点知识内容并回写成功后，`GET /api/v1/card-contents/{card_content_id}` 仅向内容所有者返回 ready 内容、示例和来源引用，不返回 teaching_memory 或生成元数据。

节点内容 ready 后，`POST /api/v1/plan-nodes/{node_id}/post-assessment-runs` 创建后测 AgentRun；节点完成标记仅记录个人进度，不是后测前置条件。
