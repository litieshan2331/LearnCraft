# Web API 路由边界

本目录放置 `/api/v1` 的 Next.js Route Handler。Route Handler 只负责提取 Session、使用 Zod 校验输入、调用 application 用例并映射 HTTP 响应；不得直接编写领域规则、SQL 或模型调用。

当前已实现无需登录的 `GET /api/v1/health` 与 `GET /api/v1/version`；经 Session 鉴权的学习画像、学习目标、模型连接、前测、学习路线、节点、节点内容、节点后测、题集读取、作答和评分接口。生成类写操作使用 UUID 格式的 `Idempotency-Key`，相同键的安全重试不会重复创建资源。前测题量为 10-20 题，后测为 5-10 题；生成成功后从 AgentRun 的 `assessment_result.assessment_id` 读取题集。题集接口不会返回答案、解析或评分内部字段；后测历史通过节点级后测列表和作答记录接口读取。模型连接只支持 OpenAI-compatible 协议，响应永远不返回 API Key、密文、IV 或认证标签。健康检查当前只验证 Web 进程与基础运行时，数据库与外部服务的就绪检查由部署环境和 Compose 健康检查负责。

前测题集生成后，`GET /api/v1/assessments/{assessment_id}` 仍只返回题干和选项。用户必须通过 `POST /api/v1/assessments/{assessment_id}/attempts` 一次提交完整答案并携带 UUID `Idempotency-Key`；服务端同步完成确定性评分，成功响应才返回正确答案和解析。`GET /api/v1/assessments/{assessment_id}/attempts` 返回当前题集的作答摘要，`GET /api/v1/assessment-attempts/{attempt_id}` 返回仅作答所有者可见的评分详情。

学习路线生成成功后，`GET /api/v1/learning-plans/{plan_id}` 返回书籍章节式路线目录，`GET /api/v1/plan-nodes/{node_id}` 返回单个章节详情；两者都按 Session 所有权过滤。路线展示页面位于 `/learning-plans/{plan_id}`。

`POST /api/v1/plan-nodes/{node_id}/content-runs` 使用 UUID `Idempotency-Key` 创建节点知识内容任务，仅允许当前有效路线中尚无成功内容的节点发起；除幂等键外还有**目标级幂等**：该节点已有在途（queued/running）任务时返回既有任务（200），不重复创建。节点 `content_status` 的流转是：创建后 `generating`、内容回写后 `ready`、最终失败 `failed`；`GET /api/v1/plan-nodes/{node_id}` 在生成中会一并返回 `latest_content_run_id`，页面据此在刷新后接上真实进度流。`plan_generate` 与 `assessment_generate` 同样采用**目标级幂等**，并各自在目标读接口带出在途任务 id（`latest_plan_run_id` / `latest_assessment_run_id`）；`posttest_generate` 的在途 id 由节点读接口的 `latest_posttest_run_id` 带出。这四个 id 都从 `agent_runs` 的 `queued`/`running` 派生，是页面刷新后恢复「生成中」显示与进度流的唯一依据。

具体接口字段以 `packages/contracts/openapi/core.yaml` 为准。

学习助手接口位于 `/api/v1/learning-assistant`：会话集合支持创建和列表，单个会话详情返回 `active_run_id`；消息集合支持发送和 `after_sequence_no` 游标分页读取全部历史；`runs/{run_id}` 返回安全运行状态。所有接口使用 Session，写操作使用已有 Origin 校验，发送消息使用 UUID `Idempotency-Key`。消息历史不受模型最近 20 轮上下文限制。本阶段仅保存用户消息和 `queued` 对话运行，队列与 Worker 尚未接入。

生成节点知识内容并回写成功后，`GET /api/v1/card-contents/{card_content_id}` 仅向内容所有者返回 ready 内容、示例和来源引用，不返回 teaching_memory 或生成元数据。

节点内容 ready 后，`POST /api/v1/plan-nodes/{node_id}/post-assessment-runs` 创建后测 AgentRun；节点完成标记仅记录个人进度，不是后测前置条件。 `GET /api/v1/plan-nodes/{node_id}/post-assessments` 返回该节点的后测题集；最新一套未交卷前不能生成下一套，交卷后可再次生成。`GET /api/v1/plan-nodes/{node_id}/post-assessment-attempts` 返回所有已完成后测的评分摘要。
