# Planning 限界上下文

本上下文负责学习目标、路线版本、路线节点、前置依赖与可解释的路线调整。Python Worker 只能通过内部契约提交校验后的生成结果，不能直接写入本上下文的业务表。

`domain` 维护路线不变量；`application` 组织创建目标和请求生成路线等用例；`infrastructure` 提供 Drizzle repository、Outbox 与 Worker HTTP adapter；`interfaces` 只处理边界输入输出。
