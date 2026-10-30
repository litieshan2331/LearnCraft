# Design

## Context

详见 `proposal.md` 的问题背景。现有学习助手面板和 API 客户端已实现会话恢复、游标分页、幂等发送和运行轮询，但 `apps/web/src/app/(learn)/layout.tsx` 中入口仍被注释；`apps/web/tests/e2e/` 只有占位 README，没有 Playwright 配置。公开会话响应已有 `stage`，Worker 完成时把 `response`、`pending_question` 和 `hint_level` 写入会话 `state_json`，但公开 presenter 未投影这些字段。Worker 图已有真实 PostgreSQL Checkpoint 集成测试和假模型端口，可作为端到端测试的复用基础。

## Goals / Non-Goals

**Goals:**

- 在 `/onboarding` 学习起点显示并接入现有学习助手面板。
- 让公开页面能够展示阶段、最多一个待回答的主要问题和 0–3 提示级别，同时保持现有内部数据隔离。
- 通过浏览器验证从页面到持久化回复的真实队列执行链路，并覆盖刷新和 Worker 重试恢复。
- 保持真实 Provider 调用和费用不进入默认 E2E 流程。

**Non-Goals:**

- 重做学习助手对话 UI、会话 API 或数据库模型。
- 改变 LangGraph 的教学规则、模型预算、记忆写入策略或 Worker 生产出网策略。
- 将完整模型轨迹、工具内容或长期记忆原文公开给浏览器。
- 把模型最近 20 轮上下文限制施加到页面历史记录。

## Decisions

1. **入口挂载在学习起点页面，而非所有学习页面。** 将 `LearningAssistantPanel` 接入 onboarding 页面组合，避免解开共享学习布局中的注释后把范围意外扩展到目标、观测和设置页面。若 onboarding 主体不适合作为挂载点，再在其页面级容器中组合入口；不改变现有工作台导航结构。

2. **只公开状态快照的允许字段。** 会话 presenter 从已保存的 `stateJson` 投影 `stage`、`pending_question` 和 `hint_level`；`pending_question` 是 `string | null`，`hint_level` 是 `0–3` 整数，缺失或格式异常时分别使用 `null` 和 `0`。不得直接序列化整个 `stateJson`。客户端类型和 `packages/contracts/openapi/core.yaml` 同步。新增字段作为必返的安全快照字段，保持旧客户端可忽略额外响应字段。

3. **端到端测试使用测试专用 Worker 装配。** Playwright 启动 Web、真实 Outbox Dispatcher 和隔离 BullMQ 消费者；消费者复用生产 `createLearningAssistantRunProcessor`、LangGraph 图、PostgreSQL Checkpoint 和内部 API，但通过现有 `ModelPort` 注入可脚本化假模型。这样测试真实队列、内部鉴权、运行锁、数据库写入与页面响应，不需要降低生产 HTTPS 出网策略或连接真实模型 Provider。

4. **外部依赖按测试运行隔离。** E2E 必须要求显式测试数据库 URL 和 Redis URL，使用随机测试用户/会话、专用队列前缀与测试凭据；缺少配置时明确跳过或失败提示，不得回退读取 `infra/.env`、`DATABASE_URL` 或生产环境。测试 teardown 仅清理自身生成的数据和队列键。

5. **保留现有 UI API 调用顺序。** 组件打开时恢复会话、分页读取历史并查询 active run；发送时生成幂等键，queued/running 时禁用输入；终态后刷新消息。修复实现细节和可访问性，但不另建一套前端状态服务或重复引入轮询库。

6. **验收按可重复脚本分层。** Playwright 验证用户可见行为；同一测试 harness 的集成断言验证子 Agent 顺序、Checkpoint、证据验证、工具/模型/解析错误类型和幂等结果。真实模型或付费 Provider 不属于第五步验收。

## Risks / Trade-offs

- [公开会话响应新增教学状态字段会扩大 API 表面] → 仅从 `state_json` 提取白名单字段，增加 OpenAPI 与 presenter 回归测试；字段范围已由用户确认。
- [测试 Worker harness 与生产启动装配可能逐渐偏离] → 复用生产队列处理器和图，只替换模型端口；将假模型装配保持为测试代码并让端到端流程经过实际内部 HTTP API。
- [Playwright 同时启动 Web、Dispatcher、Worker、PostgreSQL 和 Redis 增加本机启动成本] → 提供单一命令、依赖预检和明确清理逻辑；浏览器用例尽量复用已启动服务。
- [失败注入可能留下 Checkpoint 或队列数据] → 每个测试使用随机 ID、专用 Redis 前缀，清理自身线程与记录，并在失败时输出可定位的资源 ID。
- [轮询测试容易受调度时序影响] → 假模型按测试脚本确定性响应，使用状态断言和有界超时，不依赖固定 sleep 作为成功条件。

## Migration Plan

无需数据库迁移。新增公开响应字段保持向后兼容；部署顺序可先部署兼容字段的 Web/API，再开放页面入口。若发生问题，可回退页面入口和 UI 代码；新增字段可保留，不影响旧客户端。E2E 测试基础设施不参与生产部署。

## Open Questions

无。公开字段集合定为 `stage`、`pending_question` 和 `hint_level`。
