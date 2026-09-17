# src：Agent Worker 源码

本目录存放 TypeScript 版 Agent Worker 的实现代码，按“上层依赖下层”的方向组织；
当前只实现了基础设施层的一部分。

子目录：

- `infrastructure/`：与外部系统交互的实现（数据库、模型出网与凭据）。

按 [docs/09](../../docs/09-全栈TypeScript迁移方案.md) 第 6 节，后续将补齐 `bootstrap/`、`dispatcher/`、
`queue/`、`application/`、`workflows/`、`schemas/`、`acl/`、`main/`。

依赖方向不可反向：基础设施层不得依赖业务流程，业务工作流也不得绕过端口直接访问数据库或出网。
