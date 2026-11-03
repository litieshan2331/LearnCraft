# Proposal

## Why

当前 `plan_generate` 直接使用目标、学习画像和前测结构化快照生成学习路线；这些数据无法完整表达学习者对学习重点、节奏和内容偏好的临时判断，模型只能在不确定时自行假设。需要在路线生成中加入可恢复的 Human-in-the-Loop 检查点，让模型先基于完整快照提出少量可回答的问题，用户确认后再继续生成路线，同时避免人工等待占用 Worker、队列和 Provider 并发许可。

## What Changes

- 为学习路线生成增加 LangGraph.js 编排图，在最终路线生成前加入人工确认检查点。
- 模型读取服务端冻结的目标、学习画像、前测结果和必要的路线生成上下文后，按需生成 1–3 个问题；每个问题提供恰好 3 个选项，其中第三个选项支持用户输入自定义文本。
- 通过 PostgreSQL Checkpoint 持久化图状态；图在等待人工确认时中断，AgentRun 进入 `waiting_for_human`，不持有模型租约、Worker active 槽位或数据库连接。
- 增加安全的待确认问题读取和答案提交接口；用户提交选项后以幂等方式恢复同一个 AgentRun，并重新投递 BullMQ 继续执行。
- 将用户答案作为版本化、结构化的补充上下文交给模型，生成并校验现有 `learning_plan.v1` 路线合同后幂等持久化。
- 更新 Web 路线生成界面，展示问题和三个选项，支持第三项自定义输入、刷新恢复、提交中禁用和错误重试。
- 保留现有 Outbox、长任务池、模型出网、限流、重试和路线结果校验边界；不得公开模型原始思考、提示词、工具载荷或凭据。

## Capabilities

### New Capabilities

- `plan-generation-human-review`: 学习路线生成中的结构化人工确认、LangGraph 中断/恢复、答案提交和安全展示。

### Modified Capabilities

- `agent-worker-ts`: `plan_generate` 从不可暂停的单次 ReAct 工作流扩展为可使用 LangGraph Checkpoint 暂停和恢复的工作流，并新增 `waiting_for_human` 生命周期与恢复幂等要求。

## Impact

- Worker：`apps/agent-worker-ts/src/workflows/plan-generate/` 增加 LangGraph 状态、图节点、人工问题/答案 schema 和恢复适配；复用现有模型网关、ReAct 路线生成、路线校验、工具网关和内部回写端口。
- Web/API：新增 AgentRun 人工确认状态和答案提交接口；更新学习路线生成客户端、组件和刷新恢复逻辑。
- Contracts：同步 `packages/contracts/openapi/core.yaml` 的 AgentRun 状态、人工确认问题/答案和错误合同。
- Database：扩展 AgentRun 状态及人工确认快照/事件的持久化方式；具体迁移方案在设计阶段确定，必须保持用户、目标和运行隔离。
- Queue/Outbox：人工等待期间不保留 active Job；答案提交通过 Outbox 可靠地产生同一 AgentRun 的 continuation Job。
- Tests：增加 LangGraph Checkpoint 恢复、答案幂等、权限、过期/取消、模型校验和 Web 端到端测试；默认使用假模型，不调用真实 Provider。
- Documentation：补充学习路线 Human-in-the-Loop 执行链路、公开字段边界和本地验收命令。
