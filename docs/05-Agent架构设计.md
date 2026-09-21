# LearnCraft Agent 架构设计

> 文档状态：架构结论与实施不变量（实现细节见各目录 README）
> 更新日期：2026-09-18
> 适用范围：P0 前测、学习路线、节点内容与节点后测
>
> **Agent 侧技术栈变更（2026-09-16）：**Agent 侧已确认由 Python 迁移到 TypeScript/Node.js，不保留 Python 运行时。本文保留的业务分工、上下文交接与可靠性不变量**与实现语言无关，继续有效**；迁移前的 Python/Celery 实现描述与已完成的实施说明均已删除，当前实现与剩余待办见 [09-全栈TypeScript迁移方案](./09-全栈TypeScript迁移方案.md)。

本文只保留架构结论、实施不变量与实施前确认事项。Agent 分工细节、执行流程、Tavily 检索策略与目录结构等已实现部分已删除，当前行为以实现代码与各目录 README（`apps/agent-worker-ts/`、`apps/web/`）为准。本文不新增数据库、模型或安全策略决策。

## 1. 架构结论

采用“**两个业务 Agent + 一套共享 Agent 基础设施**”的模块化单体架构：

- **Route Planner Agent**：现有文档中的 `Learning Architect` 工作流别名，负责同一目标逻辑会话中的前测生成和学习路线生成。前测用于了解学习者水平，路线生成读取前测的结构化交接快照；该 Agent 不生成知识正文。
- **Node Tutor Agent**：现有文档中的节点教学工作流，负责同一节点逻辑会话中的节点知识生成和节点后测生成。后测只在用户主动选择后生成，并读取已保存的节点内容、`worked_example` 和 `teaching_memory`；该 Agent 不调整学习路线。
- **共享基础设施**：负责 `AgentRun` 生命周期、Outbox 可靠投递、队列任务路由与重试、模型连接、安全出网和最小审计；不包含学习路线或教学内容的业务规则。LangGraph Checkpoint、费用汇总和细粒度 Trace 是保留的扩展方向，当前 P0 代码尚未接入完整实现。

两个 Agent 不直接相互调用，也不共享无限制的对话历史。当前 P0 通过 `goal_id` 或 `plan_node_id` 范围内的结构化输入快照、已保存内容和业务结果交接上下文；LangGraph Checkpoint 仍是保留方向，不能视为已启用能力。两个 Agent 之间只通过版本化、可持久化的结构化数据交接：Route Planner 将 `PlanNode.node_brief` 写入路线节点；Node Tutor 读取该摘要与目标、画像、受控资料来生成内容。

```text
Web / BFF
  ├─ 创建 assessment_generate（前测）
  ├─ 创建 plan_generate（路线）
  ├─ 创建 card_content_generate（节点内容）
  └─ 创建 posttest_generate（节点后测）
                 │
                 ▼
          AgentRun + Outbox
                 │
                 ▼
      Dispatcher → Agent Worker（BullMQ）
                 ├─ Learning Architect：前测 + 路线
                 └─ Node Tutor：节点内容 + 后测
```

Web/BFF 在同一事务内完成请求校验、创建 `AgentRun` 和写入 Outbox。独立 Dispatcher 领取 Outbox 事件并投递队列（BullMQ）；Agent Worker 按运行类型执行对应工作流。这样可将用户请求、异步任务、执行状态和业务结果关联起来，并避免业务数据已提交但异步任务未投递的情况。

## 7. 实施不变量

后续实现应持续遵守以下规则：

1. 所有模型长任务创建 `AgentRun` 并返回可查询的 `agent_run_id`；确定性评分不创建 `AgentRun`。
2. LLM 输出先经 Zod/JSON Schema、业务校验和安全策略，再调用持久化接口；未经校验的 JSON 不得写入 Core。
3. 每个工作流是单一 persona 的 ReAct 会话：Tavily 全程开放、由模型自主决定是否调用，只受 `AGENT_TOOL_MAX_CALLS` 与 `AGENT_REACT_MAX_TURNS_*` 双上限约束；校验失败只回灌脱敏字段路径，模型在同一会话内自纠。只有通过校验的结果才能持久化，用户侧不展示内部自纠路径。
4. 每个会产生任务或费用的写操作使用 `Idempotency-Key`；每节点只允许一份成功内容。
5. Web 与 Worker 统一使用 Zod（浏览器边界、HTTP、队列消息与 LLM 结构化输出）；跨语言只共享 OpenAPI/JSON Schema，不共享 ORM Model。
6. P0 数据库迁移仍以 Drizzle 为唯一入口；不启用 Alembic 与其竞争同一 PostgreSQL Schema 的迁移所有权。

## 8. 实施前确认

本文仅记录已经提出的架构方向。若后续要实际变更数据库 Schema、检索索引、模型接入、成本额度、安全出网或上线行为，应在临近实施时再次确认相应的模型版本、向量维度、预算、安全策略和迁移方案，再开始代码修改。
