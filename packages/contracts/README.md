# LearnCraft 跨语言契约

本目录是 Web/Core 与 Python Agent Worker 之间唯一可共享的接口事实来源。跨语言通信只能依赖这里的 OpenAPI 或 JSON Schema，不能共享 TypeScript ORM、Python ORM 或 Pydantic 类。

## 目录说明

```text
packages/contracts/
├─ openapi/                # HTTP API 契约
├─ events/                 # Outbox 与异步事件的 JSON Schema
├─ ts/                     # 由 OpenAPI 生成的 TypeScript 类型
└─ python/                 # 由 OpenAPI 生成的 Python DTO
```

`openapi/core.yaml` 是第一阶段的 HTTP 契约，当前先定义健康检查、版本信息、认证、学习目标、AgentRun 和统一错误响应。随着 P0 功能实现，再在同一文件中补充画像、测验、路线、卡片、代码运行及内部回写的精确 schema。

生成到 `ts/` 和 `python/` 的文件属于派生产物，不应手工修改；应修改源契约后重新生成。
