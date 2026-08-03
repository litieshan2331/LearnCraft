# Web API 路由边界

本目录放置 `/api/v1` 的 Next.js Route Handler。Route Handler 只负责提取 Session、使用 Zod 校验输入、调用 application 用例并映射 HTTP 响应；不得直接编写领域规则、SQL 或模型调用。

当前已实现无需登录的 `GET /api/v1/health` 与 `GET /api/v1/version`；经 Session 鉴权的学习画像读取与保存、学习目标创建与读取、AgentRun 状态读取和协作式取消，以及用户模型连接的列表、创建、更新、删除、设为默认接口。学习目标创建必须携带 UUID 格式的 `Idempotency-Key`，相同键的安全重试不会重复创建目标。模型连接只支持 OpenAI-compatible 协议；响应永远不返回 API Key、密文、IV 或认证标签。Route Handler 只负责请求适配；AgentRun 的创建必须由受信任的应用服务调用，不能开放成客户端可任意指定任务类型的通用接口。健康检查当前只验证 Web 进程与基础运行时，数据库与外部服务的就绪检查将在 Docker Compose 接入后补充。

具体接口字段以 `packages/contracts/openapi/core.yaml` 为准。
