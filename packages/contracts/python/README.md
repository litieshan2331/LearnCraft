# Python 生成 DTO

本目录预留给由 `openapi/core.yaml` 生成的 Python DTO。Python Worker 仍需在自身边界使用 Pydantic 执行运行时校验，生成 DTO 不能作为 SQLAlchemy ORM 模型使用。

此目录中的生成文件不手工编辑；字段变更必须先修改 OpenAPI 源契约。
