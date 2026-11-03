# Tasks

## 1. 公开状态契约

- [x] 1.1 固定学习助手公开状态字段为 `stage`、`pending_question`（`string | null`）和 `hint_level`（`0–3` 整数），缺失状态分别回退为 `null` 和 `0`；验证方式：评审 `design.md` 与 `spec.md`，确认不新增长期记忆、工具载荷或原始轨迹字段。
- [x] 1.2 从会话 `stateJson` 投影白名单状态快照，更新 Web presenter、浏览器端类型和 `packages/contracts/openapi/core.yaml`；验证方式：补充并运行 presenter/API/OpenAPI 契约测试，断言异常或缺失状态不会泄露整个 `stateJson`。
- [x] 1.3 更新学习助手模块 README，说明公开状态字段、页面历史与模型最近 20 轮上下文的边界；验证方式：按 README 中的 API 示例完成字段核对，且 Markdown 代码块和链接有效。

## 2. 学习起点页面接入

- [x] 2.1 在登录后的学习起点页面挂载 `LearningAssistantPanel`，保留现有导航、SessionGate 和响应式布局；验证方式：Web 类型检查通过，并在浏览器中登录后能找到带可访问名称的学习助手入口。
- [x] 2.2 完善面板的会话恢复、游标分页、发送、轮询和刷新恢复状态，展示阶段、待回答主要问题和提示级别；验证方式：增加组件/API 客户端测试，覆盖首次创建、已有会话、超过一页历史、queued/running/终态和刷新恢复。
- [x] 2.3 完善错误、忙碌和输入可访问性，不展示工具消息载荷，网络重试复用同一幂等键；验证方式：前端测试断言 `CONVERSATION_BUSY`、失败安全文案、重试查询和重复发送不会新增消息或运行。

## 3. E2E 测试环境与假模型

- [x] 3.1 添加 Playwright 配置、启动脚本和测试依赖预检，要求显式测试 PostgreSQL、Redis、Web、Dispatcher 和 Worker 配置；验证方式：缺少测试配置时命令给出明确提示并不会回退到 `infra/.env` 或真实 Provider。
- [x] 3.2 建立测试专用 Worker 装配和可脚本化假模型，复用生产队列处理器、内部 API、LangGraph 图、Checkpoint 和运行锁；验证方式：假模型可按测试场景返回普通回答、错题归因/导师结果、结构化错误、工具错误和一次性崩溃，且不发出真实 HTTP Provider 请求。
- [ ] 3.3 增加随机测试用户、会话、运行和 Redis 前缀的 fixture 及 teardown；验证方式：测试结束后只删除自身数据、Checkpoint 和队列键，重复执行不会污染已有数据库或 Redis。

## 4. 浏览器端到端验收场景

- [ ] 4.1 实现普通编程问题闭环：页面发送消息 → `202` → Outbox/队列 → Worker/LangGraph → 助手消息 → 页面回复；验证方式：Playwright 断言状态变化、回复内容、单条用户消息/运行和幂等助手结果。
- [ ] 4.2 实现错题归因与导师串行场景，断言最多一个主要问题、提示级别和阶段状态可见；验证方式：测试轨迹或内部断言确认子 Agent 顺序，页面不显示子 Agent 原始调用。
- [ ] 4.3 实现提示升级、实际修复验证和证据不足场景；验证方式：断言提示级别单调升级、`insufficient_evidence` 不产生学习记忆、实际验证证据才允许写入记忆。
- [ ] 4.4 实现刷新恢复、完整历史分页、重复 `Idempotency-Key` 和会话忙碌场景；验证方式：刷新后仍显示活动运行并最终只显示一份回复，超过一页历史无重复，重复发送不增加消息/运行。
- [ ] 4.5 实现模型失败、工具失败、结构化校验失败和 Worker 崩溃恢复场景；验证方式：页面只显示安全失败文案，内部状态可区分错误类型，重试从同一 Checkpoint 恢复且幂等写入不重复。

## 5. 文档与综合验证

- [ ] 5.1 更新 `apps/web/tests/e2e/README.md` 和 `docs/20-学习助手对话执行链路实施计划.md`，记录测试环境变量、启动命令、清理规则和第五步完成标准；验证方式：在干净测试环境按文档命令可启动并执行 smoke E2E。
- [ ] 5.2 运行 Web lint、typecheck、相关单元/集成测试和 Playwright E2E；验证方式：`pnpm --filter @learncraft/web lint`、Web typecheck、学习助手相关 Vitest 与 E2E 全部通过。
- [x] 5.3 运行 Worker typecheck、相关学习助手测试和构建；验证方式：`pnpm --filter @learncraft/agent-worker-ts typecheck`、学习助手测试及 `pnpm --filter @learncraft/agent-worker-ts build` 通过，且无真实 Provider 调用。
- [x] 5.4 检查变更 diff、OpenAPI、测试日志和敏感信息；验证方式：`git diff --check`、`openspec validate complete-learning-assistant-frontend-e2e --strict` 通过，且日志/响应不含密钥、原始模型轨迹或工具载荷。

## Workflow follow-up

- 评审并确认所有规划工件后，再运行 `$openspec-apply-change` 开始实现。
- 实现和验收完成后，运行 `$openspec-archive-change` 归档变更并同步正式规格。
