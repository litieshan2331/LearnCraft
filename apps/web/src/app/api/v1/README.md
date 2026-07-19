# Web API 路由边界

本目录放置 `/api/v1` 的 Next.js Route Handler。Route Handler 只负责提取 Session、使用 Zod 校验输入、调用 application 用例并映射 HTTP 响应；不得直接编写领域规则、SQL 或模型调用。

当前已实现无需登录的 `GET /api/v1/health` 与 `GET /api/v1/version`。二者共享统一服务状态响应；健康检查当前只验证 Web 进程与基础运行时，数据库与外部服务的就绪检查将在 Docker Compose 接入后补充。

具体接口字段以 `packages/contracts/openapi/core.yaml` 为准。
