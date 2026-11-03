# Proposal

## Why

学习助手的会话 API、Worker 执行链路和前端面板组件都已存在，但学习工作台布局仍注释掉入口，用户无法从“学习起点”使用该能力；仓库也只有 Playwright 依赖和占位说明，没有浏览器端到端验收。现在需要完成第五步，把已有能力接入真实页面，并用隔离的测试依赖验证发送、执行、回复、刷新恢复和异常恢复闭环。

## What Changes

- 在登录后的学习工作台提供可访问的学习助手入口，接入现有面板、会话 API 和消息游标分页能力。
- 补齐页面对 queued、running、succeeded、failed 状态的可见反馈、运行完成后的消息刷新，以及刷新后的会话和在途运行恢复。
- 对照现有公开接口补齐当前阶段、待回答问题和提示级别的安全展示：`pending_question` 为可空字符串，`hint_level` 为 `0–3` 的整数；同步更新 OpenAPI 与 Web 契约测试，不暴露长期记忆原文、工具载荷或内部轨迹。
- 建立 Playwright E2E 配置和隔离测试环境，在测试 PostgreSQL、Redis 与假模型下验证真实 Web → Outbox → BullMQ → Worker → LangGraph → 持久化 → 页面读取链路。
- 覆盖普通问答、错题归因与导师串行调用、单一主要问题、提示升级、修复验证、证据不足、错误分类、Checkpoint 恢复、幂等重试和完整历史分页等第五步验收场景。

## Capabilities

### New Capabilities
- `learning-assistant-conversation`：学习起点中的会话入口、完整消息历史、运行状态恢复、教学状态呈现及用户可见信息边界。

### Modified Capabilities

无。现有 `agent-worker-ts` 规格描述的 Worker 执行和恢复行为在本变更中作为验收基线，不改变其业务要求。

## Impact

- Web：`apps/web/src/app/(learn)/layout.tsx`、学习助手 presentation 组件/API 客户端、学习助手公开 presenter/schema/API 测试，以及 Playwright 配置与 E2E 测试。
- Worker：优先复用现有 `apps/agent-worker-ts` 学习助手图、队列处理器和 Checkpoint；仅在端到端测试接线需要时增加测试装配，不改变生产模型 Provider 策略。
- Contracts：在 `packages/contracts/openapi/core.yaml` 与 Web presenter/API 测试同步定义最小、非敏感的状态快照，公开 `pending_question`（可空字符串）和 `hint_level`（0–3 整数）。
- 测试基础设施：使用明确隔离的测试 PostgreSQL 和 Redis 命名空间，并注入假模型；E2E 默认不得调用真实模型、产生真实费用或触碰开发/生产数据。
- 文档：完成 `docs/20-学习助手对话执行链路实施计划.md` 第五步的验收记录与 E2E 使用说明。
