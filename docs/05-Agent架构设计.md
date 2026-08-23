# LearnCraft Agent 架构设计

> 文档状态：目标架构说明  
> 更新日期：2026-08-23  
> 适用范围：P0 学习路线生成与节点内容生成

本文依据现有 DDD 边界、P0 实施约束和 Agent 运行模型，说明 LearnCraft 的 Agent 分工、执行流程、可靠投递和推荐目录结构。本文不新增数据库、模型或安全策略决策；实施时仍以 `02-DDD项目目录.md` 与 `04-MVP-P0实施需求与开发指南.md` 中的已锁定约束为准。

## 1. 架构结论

采用“**两个业务 Agent + 一套共享 Agent 基础设施**”的模块化单体架构：

- **Route Planner Agent**：现有文档中的 `Learning Architect` 工作流别名，负责根据学习目标、画像与已评分前测，生成并校验学习路线；不生成知识正文。
- **Node Tutor Agent**：在用户首次打开路线节点时按需执行，负责生成该节点的唯一学习内容、引用信息和教学记忆；不调整学习路线。
- **共享基础设施**：负责 `AgentRun` 生命周期、Outbox 可靠投递、Celery 任务路由与重试、模型连接、安全出网、追踪、费用记录和 LangGraph Checkpoint；不包含学习路线或教学内容的业务规则。

两个 Agent 不直接相互调用，也不共享无限制的对话历史。它们以版本化、可持久化的结构化数据交接：Route Planner 将 `PlanNode.node_brief` 写入路线节点；Node Tutor 读取该摘要与目标、画像、受控资料来生成内容。

```text
Web / BFF
  ├─ 创建 plan_generate
  └─ 创建 card_content_generate
                 │
                 ▼
          AgentRun + Outbox
                 │
                 ▼
      Dispatcher → Celery Worker
                 ├─ Route Planner Agent
                 └─ Node Tutor Agent
```

Web/BFF 在同一事务内完成请求校验、创建 `AgentRun` 和写入 Outbox。独立 Dispatcher 领取 Outbox 事件并投递 Celery；Celery Worker 按运行类型执行对应工作流。这样可将用户请求、异步任务、执行状态和业务结果关联起来，并避免业务数据已提交但异步任务未投递的情况。

## 2. 责任边界

| 层级 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| Web/Core | 用户、目标、画像、学习计划、节点、内容、评测等业务聚合；鉴权、幂等和业务不变量 | 直接编排 LLM 调用或保存原始模型响应 |
| Route Planner Agent | 输入规范化、路线生成、结构化校验、有限修复 | 知识正文生成、直接写入 Core 业务表 |
| Node Tutor Agent | 检索、节点内容生成、引用校验、有限修复与安全降级 | 路线调整、直接写入 Core 业务表 |
| 共享 Agent 基础设施 | 运行管理、队列、重试、模型连接、追踪、预算、Checkpoint | 路线合格性或教学内容质量等业务定义 |

Worker 只能经 `CoreApiPort`、`RetrieverPort` 等端口或 ACL 与 Core 通信，不能导入 Web 的领域对象、共享 ORM Model，或绕过应用服务写入 `learning_plans`、`plan_nodes`、`card_contents` 等核心业务表。

## 3. Route Planner Agent

### 3.1 输入与输出

Route Planner 读取：

- 学习目标；
- 当前学习者画像，以及必要的画像版本和输入快照；
- 已确定性评分的前测结果。

它输出一个含 6–12 个主题节点的学习路线。节点至少包含以下字段：

| 字段 | 含义 |
| --- | --- |
| `node_key` | 路线内稳定标识 |
| `ordinal` | 推荐学习顺序 |
| `title` | 节点标题 |
| `node_brief` | 供 Node Tutor 消费的节点摘要 |
| `learning_objective` | 节点学习目标 |
| `rationale` | 设置该节点和顺序的理由 |
| `difficulty` | 难度分级 |
| `estimated_minutes` | 预计学习时长 |
| `prerequisite_node_keys` | 前置节点标识列表 |
| `completion_criteria` | 节点完成标准 |

前置关系用于学习建议与展示，不作为节点访问锁；用户可以任选节点进入学习。

### 3.2 工作流

```text
输入：目标、画像、已评分前测
          │
          ▼
   InputNormalizer
          │
          ▼
    PlanGenerator
          │
          ▼
    PlanValidator
       ┌──┴──┐
     合法    不合法
      │        │
      ▼        ▼
   Persist   Repair 1 → Validate → Repair 2 → Validate
                                      ┌────┴────┐
                                    合法      仍不合法
                                     │           │
                                     ▼           ▼
                                  Persist  AgentRun failed
```

`PlanValidator` 应校验字段完整性、节点数量、顺序连续性、`node_key` 唯一性、前置依赖存在性、依赖无环，以及学习目标的节点覆盖关系。路线在两次修复后仍不合法时，必须以失败态结束，不能将不合法路线展示给用户；否则错误依赖可能破坏学习建议和数据关联。

## 4. Node Tutor Agent

### 4.1 触发与输入

Node Tutor 在用户首次请求某节点内容时按需执行；同一节点已有成功内容时，应直接返回该内容而非再次调用模型。它读取：

- 当前路线节点及其 `node_brief`；
- 学习目标、当前画像和必要输入快照；
- 已审核的受控资料与可溯源的检索结果。

### 4.2 工作流

```text
输入：节点、目标、画像、受控资料
          │
          ▼
ContentInputNormalizer
          │
          ▼
       Retriever
          │
          ▼
  ContentGenerator
          │
          ▼
  ContentValidator
       ┌──┴──┐
     合法    不合法
      │        │
      ▼        ▼
   Persist   Repair 1 → Validate → Repair 2 → Validate
                                      ┌────┴───────┐
                                    合法       仍不合法
                                     │             │
                                     ▼             ▼
                                  Persist   SanitizeFallback
                                                   │
                                                   ▼
                                           保存可读降级内容
```

内容在两次修复后仍未通过校验时，不得向用户直接返回原始生成内容。`SanitizeFallback` 应输出经过安全清洗、可阅读但带降级状态的内容，并记录可诊断的校验错误。

### 4.3 内容合同

节点内容建议由以下区块组成：

- `foundation`：核心概念与必要前置知识；
- `worked_example`：完整的可阅读示例；
- `pitfalls_debug`：常见误区与排错说明；
- `source_refs`：带来源定位的引用；
- `teaching_memory`：供后续节点后测出题使用的结构化教学要点。

`worked_example` 仅面向学习展示，可包含代码、调用顺序、预期输出和结果解释。P0 不要求或暴露依赖安装、运行命令、用户本地环境要求、服务端执行结果或 `stdout`/`stderr`；在线代码执行属于 P1 Sandbox 边界。

降级内容需要保存质量状态和原因，例如：

```json
{
  "quality_status": "degraded",
  "repair_attempts": 2,
  "validation_errors": ["worked_example.call_sequence_missing"]
}
```

## 5. 共享基础设施

共享层承担以下通用能力：

- `AgentRun` 的 `queued`、`running`、`succeeded`、`failed` 等状态流转，以及运行事件；
- Outbox 事务消息、Dispatcher 可靠领取和 Celery 投递；
- 幂等、超时、有限重试和安全的用户失败文案；
- `AgentExecutionProfile`：按 Agent 固化 Prompt 版本、输出 Schema、Token/费用上限、超时、工具白名单与重试策略；
- 账户默认模型连接的安全读取，及经过 `SafeModelEgressClient` 的模型调用；
- `trace_id`、`agent_run_id`、模型版本、Token、费用估算、错误类别等可观测数据；
- LangGraph Checkpoint 和可重放运行事件。

`AgentRun` 记录“如何执行”，不定义“什么是合格的学习计划或学习内容”。Outbox、Celery 消息、日志和 API 响应不得携带用户 API Key、完整 Prompt、未脱敏模型响应或用户私密资料。

## 6. 推荐目录结构

以下结构与现有 `apps/web`、`apps/agent-worker` 和 `packages/contracts` 的边界一致；其中具体文件按当前迭代增量创建。

```text
apps/
├─ web/
│  └─ src/
│     ├─ modules/
│     │  ├─ planning/
│     │  │  ├─ domain/
│     │  │  │  ├─ learning-plan.ts
│     │  │  │  ├─ plan-node.ts
│     │  │  │  └─ plan-validation.ts
│     │  │  ├─ application/
│     │  │  │  ├─ request-plan-generation.ts
│     │  │  │  ├─ get-learning-plan.ts
│     │  │  │  └─ plan-result-service.ts
│     │  │  ├─ infrastructure/
│     │  │  │  ├─ drizzle-planning-repository.ts
│     │  │  │  └─ planning-service-factory.ts
│     │  │  ├─ interfaces/
│     │  │  │  ├─ planning-schemas.ts
│     │  │  │  ├─ planning-http.ts
│     │  │  │  └─ planning-presenter.ts
│     │  │  └─ presentation/
│     │  │     ├─ learning-plan-view.tsx
│     │  │     └─ plan-generation-flow.tsx
│     │  ├─ content/
│     │  │  ├─ domain/
│     │  │  │  ├─ card-content.ts
│     │  │  │  ├─ content-document.ts
│     │  │  │  └─ content-validation.ts
│     │  │  ├─ application/
│     │  │  │  ├─ request-node-content.ts
│     │  │  │  ├─ get-card-content.ts
│     │  │  │  └─ content-result-service.ts
│     │  │  ├─ infrastructure/
│     │  │  │  ├─ drizzle-content-repository.ts
│     │  │  │  └─ retriever-adapter.ts
│     │  │  ├─ interfaces/
│     │  │  │  ├─ content-schemas.ts
│     │  │  │  └─ content-presenter.ts
│     │  │  └─ presentation/
│     │  │     ├─ node-content-view.tsx
│     │  │     ├─ content-section.tsx
│     │  │     └─ content-pagination.tsx
│     │  └─ agent-run/
│     │     ├─ domain/
│     │     ├─ application/
│     │     └─ infrastructure/
│     └─ app/
│        ├─ api/v1/learning-goals/[goalId]/plans/
│        ├─ api/v1/learning-plans/[planId]/
│        ├─ api/v1/plan-nodes/[nodeId]/
│        └─ internal/v1/agent-runs/[agentRunId]/
├─ agent-worker/
│  └─ src/learncraft_agent/
│     ├─ core/
│     │  ├─ config.py
│     │  ├─ celery_app.py
│     │  └─ agent_execution_profiles.py
│     ├─ application/
│     │  ├─ commands/execute_agent_run.py
│     │  ├─ dto/
│     │  ├─ ports/
│     │  └─ services/
│     ├─ workflows/
│     │  ├─ route_planner/
│     │  │  ├─ graph.py
│     │  │  ├─ state.py
│     │  │  ├─ schemas.py
│     │  │  ├─ nodes.py
│     │  │  ├─ validators.py
│     │  │  └─ prompts.py
│     │  └─ node_tutor/
│     │     ├─ graph.py
│     │     ├─ state.py
│     │     ├─ schemas.py
│     │     ├─ nodes.py
│     │     ├─ validators.py
│     │     ├─ fallback.py
│     │     └─ prompts.py
│     ├─ acl/web_core_internal_client.py
│     ├─ tools/
│     └─ infrastructure/
│        ├─ llm/
│        ├─ retrieval/
│        ├─ persistence/
│        ├─ checkpoint/
│        └─ queue/
└─ packages/
   └─ contracts/
      ├─ openapi/core.yaml
      ├─ events/
      │  ├─ plan-generated.v1.schema.json
      │  └─ card-content-generated.v1.schema.json
      ├─ ts/
      └─ python/
```

Web 端的 `planning`、`content` 和 `agent-run` 分别承载路线、内容和异步运行管理。Worker 的 `workflows/` 只保存 LangGraph 工作流；`application/ports/` 声明对 Core API、模型和检索的依赖；`acl/` 负责 Web Core DTO 与 Agent DTO 的防腐转换；第三方具体实现集中在 `infrastructure/`。跨语言接口和事件只通过 `packages/contracts` 共享并进行版本化。

## 7. 实施不变量

后续实现应持续遵守以下规则：

1. 所有模型长任务创建 `AgentRun` 并返回可查询的 `agent_run_id`；确定性评分不创建 `AgentRun`。
2. LLM 输出先经 Pydantic/JSON Schema、业务校验和安全策略，再调用持久化接口；未经校验的 JSON 不得写入 Core。
3. Route Planner 的失败不产生可展示路线；Node Tutor 的失败必须进入安全失败态或降级内容，不能泄露原始模型输出。
4. 每个会产生任务或费用的写操作使用 `Idempotency-Key`；每节点只允许一份成功内容。
5. Web 的浏览器边界使用 Zod，Worker 的 HTTP、队列和模型输出使用 Pydantic；跨语言只共享 OpenAPI/JSON Schema，不共享 ORM Model。
6. P0 数据库迁移仍以 Drizzle 为唯一入口；不启用 Alembic 与其竞争同一 PostgreSQL Schema 的迁移所有权。

## 8. 实施前确认

本文仅记录已经提出的架构方向。若后续要实际变更数据库 Schema、检索索引、模型接入、成本额度、安全出网或上线行为，应在临近实施时再次确认相应的模型版本、向量维度、预算、安全策略和迁移方案，再开始代码修改。