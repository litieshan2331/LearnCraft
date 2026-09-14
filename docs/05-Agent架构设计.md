# LearnCraft Agent 架构设计

> 文档状态：P0 架构与当前实现说明
> 更新日期：2026-09-14
> 适用范围：P0 前测、学习路线、节点内容与节点后测

本文依据现有 DDD 边界、P0 实施约束和 Agent 运行模型，说明 LearnCraft 的 Agent 分工、执行流程、可靠投递和推荐目录结构。本文不新增数据库、模型或安全策略决策；当前行为以实现代码、`packages/contracts` 与 `apps/agent-worker/README.md` 为准，`04-MVP-P0实施需求与开发指南.md` 仅保留历史实施基线。

## 1. 架构结论

采用“**两个业务 Agent + 一套共享 Agent 基础设施**”的模块化单体架构：

- **Route Planner Agent**：现有文档中的 `Learning Architect` 工作流别名，负责同一目标逻辑会话中的前测生成和学习路线生成。前测用于了解学习者水平，路线生成读取前测的结构化交接快照；该 Agent 不生成知识正文。
- **Node Tutor Agent**：现有文档中的节点教学工作流，负责同一节点逻辑会话中的节点知识生成和节点后测生成。后测只在用户主动选择后生成，并读取已保存的节点内容、`worked_example` 和 `teaching_memory`；该 Agent 不调整学习路线。
- **共享基础设施**：负责 `AgentRun` 生命周期、Outbox 可靠投递、Celery 任务路由与重试、模型连接、安全出网和最小审计；不包含学习路线或教学内容的业务规则。LangGraph Checkpoint、费用汇总和细粒度 Trace 是保留的扩展方向，当前 P0 代码尚未接入完整实现。

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
      Dispatcher → Celery Worker
                 ├─ Learning Architect：前测 + 路线
                 └─ Node Tutor：节点内容 + 后测
```

Web/BFF 在同一事务内完成请求校验、创建 `AgentRun` 和写入 Outbox。独立 Dispatcher 领取 Outbox 事件并投递 Celery；Celery Worker 按运行类型执行对应工作流。这样可将用户请求、异步任务、执行状态和业务结果关联起来，并避免业务数据已提交但异步任务未投递的情况。

## 2. 责任边界

| 层级 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| Web/Core | 用户、目标、画像、学习计划、节点、内容、评测等业务聚合；鉴权、幂等和业务不变量 | 直接编排 LLM 调用或保存原始模型响应 |
| Route Planner Agent | 前测生成、路线生成、结构化校验、有限修复与 Tavily 兜底 | 知识正文生成、直接写入 Core 业务表 |
| Node Tutor Agent | 节点内容生成、引用校验、节点后测生成、有限修复与 Tavily 兜底 | 路线调整、直接写入 Core 业务表 |
| 共享 Agent 基础设施 | 运行管理、队列、重试、模型连接、安全出网和最小运行审计；细粒度 Trace、成本汇总、Checkpoint 为后续能力 | 路线合格性或教学内容质量等业务定义 |

Worker 只能经 `CoreApiPort`、`RetrieverPort` 等端口或 ACL 与 Core 通信，不能导入 Web 的领域对象、共享 ORM Model，或绕过应用服务写入 `learning_plans`、`plan_nodes`、`card_contents` 等核心业务表。

### 2.1 可复用的 BaseAgent

两个业务 Agent 共享同一个 `BaseAgent` 执行框架。`BaseAgent` 是通用执行壳，不包含前测、路线、节点内容或后测的业务规则；业务差异由工作流、Schema、Validator 和持久化 Port 注入。

```text
BaseAgent
└─ 按 run_type 路由已注册 Workflow

execute_agent_run + Repository
├─ AgentRun 生命周期、Celery 重试和终态写入
└─ 运行事件与最小错误摘要

具体 Workflow
├─ ModelGateway / Tavily MCP 调用
├─ Schema 与业务校验、有限修复和恢复
└─ 对应的内部回写 Port

LearningArchitectAgent
├─ assessment_generate → AssessmentGenerationWorkflow
└─ plan_generate → PlanGenerationWorkflow

NodeTutorAgent
├─ card_content_generate → CardContentWorkflow
└─ posttest_generate → PosttestWorkflow
```

当前实现通过两个业务 Agent 各自注入工作流映射来复用 BaseAgent：

```python
# 共享 BaseAgent 执行框架不直接包含业务规则。

learning_architect_workflows = {
    "assessment_generate": AssessmentGenerationWorkflow(),
    "plan_generate": PlanGenerationWorkflow(),
}
node_tutor_workflows = {
    "card_content_generate": CardContentWorkflow(),
    "posttest_generate": PosttestWorkflow(),
}
```

当前 Worker 已注册四个 P0 `run_type`：`assessment_generate`、`plan_generate`、`card_content_generate` 和 `posttest_generate`。未注册的其他类型仍会以 `AGENT_RUN_WORKFLOW_NOT_REGISTERED` 失败。

当前 `BaseAgent` 只做 `run_type` 到 Workflow 的分发；以下流程由 `execute_agent_run`、具体 Workflow 和 Repository 协作完成：

```text
创建/恢复 AgentRun
  ↓
加载逻辑会话上下文
  ↓
调用业务 Workflow
  ↓
模型生成（工具由模型自主选择）
  ↓
Schema + 业务校验
  ↓
有限修复
  ↓
主流程最终校验仍失败 → 按该 Workflow 的恢复策略处理
  ↓
兜底后最终校验
  ↓
通过对应 Persistence Port 写入 Core
```

四个 `run_type` 使用同一套生命周期和日志机制，但拥有独立的输入 DTO、输出 Schema、业务 Validator、Prompt/Profile 和持久化方法。`learning_architect` 使用 `goal:{goal_id}` 作为逻辑会话，`node_tutor` 使用 `node:{plan_node_id}` 作为逻辑会话；共享 BaseAgent 不代表共享两个业务 Agent 的上下文。

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

### 3.2 前测与路线生成是同一个 Agent

前测和路线生成不是两个 Agent，而是学习规划 Agent 的两个阶段。二者可以创建不同的 `AgentRun`，但共享同一个 `goal_id` 逻辑会话范围，并通过结构化快照交接上下文。Checkpoint 是后续可选增强，当前 P0 不以它保存或恢复对话状态。

```text
创建目标
   │
   ▼
学习规划 Agent：assessment_generate
   ├─ 生成前测题目、隐藏答案、解析和能力标签
   └─ 校验后保存 Assessment
           │
           ▼
用户提交前测 → 服务端确定性评分
           │
           ▼
用户确认生成路线
           │
           ▼
学习规划 Agent：plan_generate
   ├─ 读取目标、画像和前测交接快照
   └─ 生成 6–12 章书籍式学习目录
```

前测和路线首轮会向模型提供 Tavily MCP，由模型自主决定是否调用；当前前测共享题集管线的修复阶段不开放 Tavily，最终恢复阶段才开放 Tavily 并由模型决定是否调用。路线工作流的修复阶段同样不开放工具，主流程最终校验失败后才强制执行 Tavily 恢复；所有恢复结果都必须重新校验。

### 3.3 路线生成工作流

```text
输入：目标、画像、已评分前测
          │
          ▼
   InputNormalizer
          │
          ▼
    PlanGenerator
      （模型自主决定是否调用 Tavily）
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
                                  Persist   强制 Tavily MCP
                                                   │
                                      搜索 + 资源阅读 + 重建
                                                   │
                                                   ▼
                                            PlanValidator
                                                   │
                                                   ▼
                                                 Persist
```

路线必须采用书籍章节目录式结构，而不是通用的“了解概念—完成练习—复盘”阶段模板。`PlanValidator` 应校验字段完整性、节点数量、章节顺序连续性、`node_key` 唯一性、前置依赖存在性、依赖无环，以及学习目标的主题覆盖关系。当前路线工作流的首轮模型可以自主调用 Tavily；修复请求不开放工具；主流程最终校验仍不合法时，才强制使用 Tavily MCP 进行搜索和资源阅读。Tavily 资料会被用于重建章节目录，重建结果还必须再次通过同一套校验。

只要最终得到合法章节目录，对用户侧就是正常成功；首轮失败、修复失败、工具调用、校验错误和兜底路径仅写入内部 AgentRun 事件和日志。

## 4. Node Tutor Agent

### 4.1 节点内容与后测是同一个 Agent

节点内容生成和节点后测生成不是两个 Agent，而是节点教学 Agent 的两个阶段。二者可以创建不同的 `AgentRun`，但共享同一个 `plan_node_id` 逻辑会话范围，并通过已保存的固定内容和 `teaching_memory` 交接上下文；当前 P0 不使用 Checkpoint 恢复对话状态。

Node Tutor 在用户首次请求某节点内容时按需执行；同一节点已有成功内容时，应直接返回该内容而非再次调用模型。用户可以独立标记节点完成作为个人进度记录；后测只要求对应节点存在 ready 内容，不受节点完成状态或前置关系限制。它读取：

- 当前路线节点及其 `node_brief`；
- 学习目标、当前画像和必要输入快照；
- 已审核的受控资料与可溯源的检索结果。

```text
用户打开节点
   │
   ▼
节点教学 Agent：card_content_generate
   ├─ 生成 foundation、worked_example、pitfalls_debug
   ├─ 校验引用和内容结构
   └─ 保存唯一成功内容、worked_example 和 teaching_memory
           │
           ▼
用户阅读内容后可主动选择生成后测（节点完成标记仅用于记录）
           │
           ▼
节点教学 Agent：posttest_generate
   ├─ 读取固定内容、worked_example 和 teaching_memory
   └─ 生成新的节点后测题集
```

### 4.2 内容生成工作流

```text
输入：节点、目标、画像
          │
          ▼
ContentInputNormalizer
          │
          ▼
  ContentGenerator
  （模型自主决定是否调用 Tavily）
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
                                  Persist     强制 Tavily MCP
                                                   │
                                      搜索 + 资源阅读 + 重建
                                                   │
                                                   ▼
                                           ContentValidator
                                                   │
                                                   ▼
                                                 Persist
```

节点内容首轮模型可以自主调用 Tavily；当前修复请求不开放工具，主流程最终校验仍不合法时才强制执行 Tavily 搜索和资源阅读，并基于资料重建内容。若 Tavily 本身不可用，当前实现会改用模型已有稳定知识进行一次同合同恢复。任一路径的结果都必须再次通过 `ContentValidator`；用户侧不展示中间修复或恢复路径。

前测和后测题集共享 `apps/agent-worker/src/learncraft_agent/workflows/question_set_generation.py` 中的 `QuestionSetGenerationPipeline`。共享管线负责题集 JSON 解析、字段合同校验、题量校验、错误路径摘要和有限恢复，不负责业务持久化。前测首轮开放 Tavily、修复阶段不开放、最终恢复阶段开放；后测首轮只使用固定 `CardContent` 和 `teaching_memory`，修复和最终恢复阶段开放 Tavily。

### 4.3 内容合同

节点内容建议由以下区块组成：

- `foundation`：核心概念与必要前置知识；
- `worked_example`：完整的可阅读示例；
- `pitfalls_debug`：常见误区与排错说明；
- `source_refs`：带来源定位的引用；
- `teaching_memory`：供后续节点后测出题使用的结构化教学要点。

`worked_example` 仅面向学习展示，可包含代码、调用顺序、预期输出和结果解释。P0 不要求或暴露依赖安装、运行命令、用户本地环境要求、服务端执行结果或 `stdout`/`stderr`；在线代码执行属于 P1 Sandbox 边界。

无论正常路径还是 Tavily 兜底路径，均使用同一内容合同。内部需要保存生成路径和原因，例如：

```json
{
  "quality_status": "degraded",
  "generation_path": "tavily_recovery",
  "repair_attempts": 2,
  "validation_errors": ["worked_example.call_sequence_missing"]
}
```

## 5. 共享基础设施

共享层承担以下通用能力：

- `AgentRun` 的 `queued`、`running`、`succeeded`、`failed` 等状态流转，以及运行事件；
- Outbox 事务消息、Dispatcher 可靠领取和 Celery 投递；
- 幂等、超时、有限重试和安全的用户失败文案；
- 当前由各 Workflow 固化 Prompt、输出 Schema、超时、工具白名单与重试策略；版本化 `AgentExecutionProfile` 是后续可抽取的配置能力；
- Tavily MCP 适配：同一个 MCP 提供搜索和资源阅读；是否开放以及是否强制调用由具体工作流阶段决定；
- 账户默认模型连接的安全读取，及经过 `SafeModelEgressClient` 的模型调用；
- 当前已持久化的 `trace_id`、`agent_run_id`、运行状态、重试次数、模型标识和安全错误摘要；
- 后续可增加 Token/费用汇总、细粒度工具 Trace、LangGraph Checkpoint 和可重放运行事件。

### 5.1 Tavily MCP 检索策略

Tavily MCP 的连接配置、认证方式、超时、预算、调用次数和安全出网参数沿用项目现有配置，本次 Agent 架构不另起一套参数。搜索和资源阅读仍由同一个 Tavily MCP 提供，工作流采用既有的“先广搜、后缩搜”策略：

1. **广搜**：围绕学习目标、章节主题或节点问题获取候选权威来源；
2. **缩搜**：根据候选来源、章节标题、引用定位和缺失信息继续检索；
3. **资源阅读**：读取最终选定的来源，提取可用于章节目录、知识内容或校验修复的结构化资料；
4. **结果重建**：将资料交给当前 Agent 重建章节目录、内容或题目，再执行原有 Schema 和业务校验。

首轮、修复和最终恢复阶段的 Tavily 策略由具体工作流决定。开放 Tavily 的阶段由模型自主决定是否调用；只有明确配置为强制恢复的工作流才在最终校验失败后强制执行 Tavily。

`AgentRun` 记录“如何执行”，不定义“什么是合格的学习计划或学习内容”。Outbox、Celery 消息、日志和 API 响应不得携带用户 API Key、完整 Prompt、未脱敏模型响应或用户私密资料。

## 6. 推荐目录结构

以下是**后续演进的推荐结构**，用于保持 `apps/web`、`apps/agent-worker` 和 `packages/contracts` 的边界一致，并非当前仓库的逐文件清单。当前 Worker 的四个 P0 工作流位于 `apps/agent-worker/src/learncraft_agent/workflows/`，尚未拆为下述 `route_planner/`、`node_tutor/` 目录，也没有运行 LangGraph 图。

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

Web 端的 `planning`、`content` 和 `agent-run` 分别承载路线、内容和异步运行管理。当前 Worker 的 `workflows/` 保存显式 Python 工作流；未来接入 LangGraph 后，图定义可按上方结构拆分。`application/ports/` 声明对 Core API、模型和检索的依赖；`acl/` 负责 Web Core DTO 与 Agent DTO 的防腐转换；第三方具体实现集中在 `infrastructure/`。跨语言接口和事件只通过 `packages/contracts` 共享并进行版本化。

## 7. 实施不变量

后续实现应持续遵守以下规则：

1. 所有模型长任务创建 `AgentRun` 并返回可查询的 `agent_run_id`；确定性评分不创建 `AgentRun`。
2. LLM 输出先经 Pydantic/JSON Schema、业务校验和安全策略，再调用持久化接口；未经校验的 JSON 不得写入 Core。
3. 各工作流按阶段决定 Tavily 是否开放：前测首轮和最终恢复、后测修复和最终恢复由模型自主决定；路线和内容在最终恢复阶段强制执行 Tavily；所有修复阶段均不开放工具。只有再次通过校验的结果才能持久化，用户侧不展示内部恢复路径。
4. 每个会产生任务或费用的写操作使用 `Idempotency-Key`；每节点只允许一份成功内容。
5. Web 的浏览器边界使用 Zod，Worker 的 HTTP、队列和模型输出使用 Pydantic；跨语言只共享 OpenAPI/JSON Schema，不共享 ORM Model。
6. P0 数据库迁移仍以 Drizzle 为唯一入口；不启用 Alembic 与其竞争同一 PostgreSQL Schema 的迁移所有权。

## 8. 实施前确认

本文仅记录已经提出的架构方向。若后续要实际变更数据库 Schema、检索索引、模型接入、成本额度、安全出网或上线行为，应在临近实施时再次确认相应的模型版本、向量维度、预算、安全策略和迁移方案，再开始代码修改。
