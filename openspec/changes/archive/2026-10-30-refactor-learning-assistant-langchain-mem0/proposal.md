# Proposal

## Why

当前学习助手虽然使用 LangGraph 编排，但 Agent 内部的 ReAct、工具游标、子 Agent 委派和输出修复逻辑主要由工作流代码自行维护，主 Agent 与子 Agent 的边界不够贴近 LangChain 的工具模型，后续扩展角色和工具的成本较高。现有长期记忆还通过业务数据库保存结构化候选，用户已决定改用 mem0；现在需要一次性明确 Agent、State、工具和记忆的长期边界，避免继续扩大旧实现。

## What Changes

- 将主 Agent、错题归因子 Agent、苏格拉底导师子 Agent 统一整理为 LangChain Agent/Tool 形式，并由 LangGraph 负责主流程、共享 State、Checkpoint、恢复和持久化边界。
- 主 Agent 通过两个委派工具调用子 Agent；子 Agent 只能调用只读业务、Skill 和搜索工具，不能互相委派，只能通过工具结果和 LangGraph State 与主 Agent 交互。
- 子 Agent 调用失败时必须以稳定、脱敏的异常回传主 Agent，由主 Agent 决定重试、改用其他工具、降级回答或结束本轮，不得伪造子 Agent 成功结果。
- 面向用户的模型内容允许自然语言自由输出；取消对整段主回复和子 Agent 分析文本的强制 JSON 合同。工具参数、权限、证据来源、状态枚举、提示等级和记忆操作仍由程序合同校验。
- **BREAKING** 废弃现有学习助手长期记忆候选验证、写入、检索工具和 `learning_experience_memories` 运行链路；本次不接入新的长期记忆服务。
- 将 mem0 适配器、完整对话出网、记忆提取与用户记忆删除列为后续独立实施范围；部署形态、出网审批、保留策略和旧表存量处置确认前不启用。
- 保留会话消息、LangGraph Checkpoint、内部轨迹和短期上下文；不把 mem0 原始记忆或内部 Agent 轨迹暴露到公开会话 API。
- 增加测试和观测要求，覆盖主子 Agent 顺序、工具白名单、State 恢复、自由文本输出和子 Agent 异常回传。

## Capabilities

### New Capabilities

- 无。本次不实现长期记忆服务；mem0 能力另行提案。

### Modified Capabilities

- `agent-worker-ts`：修改学习助手 LangGraph 运行约束，明确 LangChain Agent/Tool 编排、主子 Agent 单向委派、State 共享、自由文本边界，并移除现有业务长期记忆写入要求。

## Impact

- Worker 工作流：`apps/agent-worker-ts/src/workflows/learning-assistant/` 的图、State、Agent、工具节点和持久化节点。
- Worker 装配与基础设施：模型适配、LangChain 工具封装、轨迹和 Checkpoint 装配。
- Web 内部接口和学习助手模块：退役旧 `learning-memory` 验证/写入接口、Repository 方法和旧表上下文读取。
- 数据库：保留 `learning_experience_memories` 表、历史迁移和记录；存量保留、导入或销毁策略另行确认，不执行破坏性迁移。
- mem0 部署、配置、外部调用、完整会话出网和故障恢复不在本次范围。
- 测试与文档：更新 Worker 单元/集成测试、OpenAPI/内部接口文档、学习助手 README 和运行实施计划。
