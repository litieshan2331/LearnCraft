# OpenAPI 契约

`core.yaml` 定义 LearnCraft 的 HTTP 接口。浏览器 API 使用 `/api/v1` 前缀；`/internal/v1` 仅允许 Web 与 Agent Worker 在私有网络中调用。

所有公开 JSON 字段使用 `snake_case`。Web Route Handler 仍须使用 Zod 校验浏览器输入，Python Worker 仍须使用 Pydantic 校验入站请求、事件和模型输出；OpenAPI 不能替代各自运行时的边界校验。
