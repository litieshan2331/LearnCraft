# LearnCraft MVP：DDD 项目目录与边界设计

> 本文件只描述领域边界、代码目录和依赖规则。建议采用“Next.js BFF/界面 + Python LangGraph Agent Worker”的模块化单体形态：业务聚合由 `apps/web` 统一持有，Agent 只负责工作流编排和工具调用。这样既保留 Next.js 的前后端一体体验，也避免 TypeScript 与 Python 各自实现一套学习领域模型。
>
> 文档状态：实施中｜更新日期：2026-07-26
>
> 配套文档：[技术栈选型](./01-技术栈选型.md) · [MVP PRD](./03-MVP-PRD.md)

## 1. MVP 的边界上下文

| Bounded Context | 类型/优先级 | 负责什么 | MVP 状态 |
| --- | --- | --- | --- |
| Identity & Learner Profile（身份与学习者画像） | 支撑 | 用户、技术栈/目标/可用时间、内容偏好、难度偏好 | 必须 |
| Learning Planning（学习规划） | 核心 | 学习目标、路线图、四阶段节点、节点状态和依赖 | 必须 |
| Learning Content（学习内容与知识库） | 核心 | 受控资料目录、URL/文档导入、解析、切块、摘要、向量索引、内容包 | 必须（P0 用人工审核资料；URL/Markdown/PDF 受控入口为 P1） |
| Assessment（前测与随堂题） | 核心 | 题目、答题、评分、掌握度，驱动路线调整 | 必须（前测/随堂均为 5–8 题：选择题 + 简答题；简答题由 AI 按 rubric 判分） |
| Practice Execution（代码实践执行） | 核心差异化 | 代码片段、运行任务、日志/结果、超时与安全策略 | MVP 只做受限 Python 3.11 Demo；实战/调试节点的 AI Demo 必须预运行验证并带调用顺序/注释结果；其他语言后置，生产沙箱必须独立 |
| Agent Orchestration（Agent 编排） | 通用技术上下文 | LangGraph 工作流、运行状态、重试、检查点、提示词版本、工具调用 | 必须，但不拥有学习业务聚合 |
| Progress & Report（进度与报告） | 支撑 | 进度条、学习报告、成就 | V1.1+，由领域事件消费 |
| Community（社区） | 支撑 | 分享、讨论、社群 | 后续 |

### 1.1 聚合与领域事件（MVP 最小集合）

- **LearnerProfile**（聚合根）：`LearnerId`、目标岗位/技术栈、当前水平、每周可用时间、`ContentPreference`。发布 `LearnerProfileCompleted`。
- **LearningPlan**（聚合根）：`PlanId`、`LearnerId`、目标、版本、状态；内部 `PlanNode` 实体包含阶段（`concept/syntax/practice/debug`）、顺序、前置节点、预计时长、状态。发布 `LearningPlanRequested`、`LearningPlanGenerated`、`PlanNodeUnlocked`。
- **ContentSource/ContentDocument**（聚合根）：来源 URL/上传文件、抓取状态、清洗后的文档和 `ContentChunk`；向量是投影而非领域实体。发布 `ContentIngested`、`ContentIndexed`。
- **Assessment**（聚合根）与 **Attempt**（高并发时独立聚合）：前测/节点测验、选择题/简答题、隐藏答案/rubric、答案、规则/AI 评分、置信度、`MasteryScore`。发布 `AssessmentSubmitted`、`MasteryUpdated`。
- **ExecutionJob**（聚合根）：用户代码或 AI Demo、运行时、资源限制、状态、stdout/stderr、产物引用；Demo 的调用顺序、注释结果和预运行验证摘要属于内容契约。发布 `ExecutionCompleted` 或 `ExecutionFailed`。
- **AgentRun**（编排上下文聚合根）：工作流类型、关联业务对象、状态、幂等键、错误和 token 用量。它记录“如何执行”，不决定“什么是合格的学习计划”。发布 `AgentRunStarted`、`AgentRunSucceeded`、`AgentRunFailed`。

MVP 先将 `LearningPlan` 内的节点作为实体保存；节点很多或需要独立协作时，再拆成 `PlanNode` 聚合。`ContentChunk` 和向量索引仅作为文档的读模型/基础设施数据，不能被 UI 直接改写。

### 1.2 上下文映射

```text
Identity/Profile ──(profile DTO)──> Learning Planning
Learning Planning ──(node/content request)──> Learning Content
Learning Planning ──(assessment request)──> Assessment
Assessment ──(AssessmentSubmitted/MasteryUpdated)──> Learning Planning
Learning Content ──(retrieval port)──> Agent Orchestration
Assessment/Planning/Content/Execution <──(ACL + internal API)── Agent Orchestration
All contexts ──(domain events/outbox)──> Progress & Report (later)
```

Agent 通过 Anti-Corruption Layer（ACL）调用 Core API/应用服务；不能直接 import `LearningPlan` 的领域类，也不应绕过应用服务写核心表。上下文之间只传版本化 DTO/事件，不共享 ORM Model。检索适配器默认调用 Content 的只读 query port；若为性能需要直连 pgvector，只能使用独立只读凭据和 Content 投影 schema，禁止读取/修改业务写模型。

## 2. 当前仓库主结构

下图以当前**已实际创建**的目录为准，聚焦 Web 与 Agent Worker 的 DDD 大框架；省略 `__init__.py`、README、依赖目录和配置文件。数据库 schema 与首份 Drizzle 迁移已经创建；Identity 已实现注册、登录、登出、当前用户 BFF 接口，以及首页、登录、注册和受会话保护的 onboarding 占位页。其余业务限界上下文仍保持目录骨架。

```text
learncraft/
├─ apps/
│  ├─ web/                                  # Next.js UI + BFF/Core API
│  │  ├─ drizzle.config.ts                   # Drizzle Kit 配置（schema 与迁移输出）
│  │  ├─ src/
│  │  │  ├─ app/                            # Next.js App Router；只组织页面、布局和 BFF 路由
│  │  │  │  ├─ (public)/                    # 公共页路由组：当前为首页 `/`
│  │  │  │  ├─ (auth)/                      # 认证页路由组：`/login`、`/register`
│  │  │  │  ├─ (learn)/                     # 登录后的学习区路由组：当前为 `/onboarding`
│  │  │  │  └─ api/v1/                      # 薄 Route Handler：health、version、auth 等 BFF 接口
│  │  │  ├─ modules/                        # Web 限界上下文
│  │  │  │  ├─ identity/                    # 邮箱密码、Session、当前用户
│  │  │  │  │  ├─ domain/
│  │  │  │  │  ├─ application/
│  │  │  │  │  ├─ infrastructure/
│  │  │  │  │  ├─ interfaces/               # Zod 请求 schema、HTTP 输入/输出适配
│  │  │  │  │  └─ presentation/             # React 表单、会话守卫、同源 BFF client
│  │  │  │  ├─ profile/                     # 学习者画像与偏好
│  │  │  │  │  ├─ domain/
│  │  │  │  │  ├─ application/
│  │  │  │  │  ├─ infrastructure/
│  │  │  │  │  └─ interfaces/
│  │  │  │  ├─ planning/                    # 目标、路线、节点与调整
│  │  │  │  │  ├─ domain/
│  │  │  │  │  ├─ application/
│  │  │  │  │  ├─ infrastructure/
│  │  │  │  │  └─ interfaces/
│  │  │  │  ├─ assessment/                  # 前测、随堂题、作答与评分
│  │  │  │  │  ├─ domain/
│  │  │  │  │  ├─ application/
│  │  │  │  │  ├─ infrastructure/
│  │  │  │  │  └─ interfaces/
│  │  │  │  ├─ content/                     # 受控资料、检索、学习卡片
│  │  │  │  │  ├─ domain/
│  │  │  │  │  ├─ application/
│  │  │  │  │  ├─ infrastructure/
│  │  │  │  │  └─ interfaces/
│  │  │  │  ├─ practice/                    # 代码运行与 Runner 适配
│  │  │  │  │  ├─ domain/
│  │  │  │  │  ├─ application/
│  │  │  │  │  ├─ infrastructure/
│  │  │  │  │  └─ interfaces/
│  │  │  │  ├─ agent-run/                   # 长任务状态与 Outbox 投递
│  │  │  │  │  ├─ domain/
│  │  │  │  │  ├─ application/
│  │  │  │  │  ├─ infrastructure/
│  │  │  │  │  └─ interfaces/
│  │  │  │  ├─ shared/kernel/               # 极小共享内核
│  │  │  │  └─ shared/ui/                   # 无业务归属的可复用 React UI（如 Brand）
│  │  │  │     └─ primitives/               # shadcn 源码：Button、Input、Field、Alert 等
│  │  │  └─ lib/                            # Web 通用框架适配
│  │  │     ├─ db/
│  │  │     │  ├─ client.ts                  # 懒加载 PostgreSQL/Drizzle 客户端
│  │  │     │  ├─ schema/                    # 22 张 P0 表、外键、索引、CHECK 与关系
│  │  │     │  └─ migrations/                # 0000 初始 SQL 与 Drizzle meta 快照
│  │  │     ├─ session/
│  │  │     ├─ outbox/
│  │  │     └─ logger/
│  │  └─ tests/
│  │     ├─ unit/
│  │     ├─ integration/
│  │     └─ e2e/
│  └─ agent-worker/                         # FastAPI + LangGraph Agent Worker
│     ├─ alembic/                           # P0 仅保留 Drizzle 所有权说明，不运行 Alembic
│     ├─ src/learncraft_agent/
│     │  ├─ core/                           # 运行时配置、Celery 应用、日志、安全与依赖注入
│     │  ├─ interfaces/
│     │  │  ├─ http/
│     │  │     ├─ routers/                  # /health、内部 AgentRun 路由
│     │  │     └─ schemas/                  # HTTP Pydantic DTO
│     │  │  └─ celery/                      # Celery 消息消费适配器与任务入口
│     │  ├─ application/
│     │  │  ├─ commands/                   # Agent 命令与处理器（含 AgentRun 执行入口）
│     │  │  ├─ dto/                        # application/workflow/队列 Pydantic DTO
│     │  │  ├─ ports/                      # Core API、LLM、检索、执行器等抽象
│     │  │  └─ services/                   # RunService、ModelGateway 等用例服务
│     │  ├─ domain/                        # 仅 Agent 自有的领域概念
│     │  │  ├─ repositories/               # AgentRun、事件、Checkpoint repository interface
│     │  │  └─ services/                   # AgentRunPolicy、BudgetPolicy 等纯规则
│     │  ├─ workflows/                     # LangGraph 编排
│     │  ├─ acl/                           # Web Core DTO ↔ Agent DTO 防腐层
│     │  ├─ tools/                         # 受控 profile、plan、retrieval、assessment、execution 工具
│     │  ├─ infrastructure/                # 所有第三方具体实现
│     │  │  ├─ llm/                        # 托管模型 Provider adapter
│     │  │  ├─ embeddings/                 # 固定 Embedding Profile adapter
│     │  │  ├─ document_parsers/           # MinerU 等文档解析 adapter
│     │  │  ├─ retrieval/                  # pgvector 或 Core API 检索 adapter
│     │  │  ├─ persistence/
│     │  │  │  ├─ database.py              # asyncpg SQLAlchemy 会话工厂
│     │  │  │  ├─ models/                  # SQLAlchemy：仅 AgentRun / AgentRunEvent
│     │  │  │  └─ repositories/            # repository 的 SQLAlchemy 实现
│     │  │  ├─ checkpoint/                 # LangGraph Checkpointer adapter
│     │  │  ├─ queue/                      # Outbox Dispatcher → Celery Broker adapter
│     │  │  └─ observability/              # 日志、指标与追踪 adapter
│     │  └─ prompts/                       # 版本化 Prompt 模板
│     └─ tests/
│        ├─ unit/
│        ├─ integration/
│        └─ e2e/
└─ packages/
   └─ contracts/                           # Web 与 Worker 的跨语言契约
      ├─ openapi/core.yaml
      ├─ events/                           # AgentRunRequested v1 等 JSON Schema
      ├─ ts/
      └─ python/
```

### 2.1 Web BC 当前分层

`identity` 已在四层 DDD 骨架之外增加 `presentation/`，承载认证 UI；`profile`、`planning`、`assessment`、`content`、`practice` 与 `agent-run` 当前仍保持四层目录骨架：

```text
apps/web/src/modules/<bounded-context>/
├─ domain/                 # 聚合、实体、值对象、领域服务、repository interface
├─ application/            # command/query、事务边界、用例编排、port
├─ infrastructure/         # Drizzle repository、Outbox、Worker/Runner adapter
├─ interfaces/             # Zod、Session 提取、HTTP presenter
└─ presentation/           # 仅 Identity 当前使用：React 组件、BFF client、页面会话守卫
```

除 Identity 外，这一层级仍是目录骨架，尚未提前创建具体聚合或 repository 文件。开始实现某个用例时，再在对应层内按需要创建 `repositories/`、`services/`、`commands/`、`dto/`、`ports/`、`persistence/` 等子目录；不要为了“目录完整”创建没有归属的空业务文件。

`shared/kernel` 只放跨 Web 上下文稳定且无业务归属的原语；`shared/ui` 只放无业务归属的 React 组件，其中 `shared/ui/primitives` 存放 shadcn/ui 生成并由仓库维护的基础组件。React Server Components 和 Route Handler 只能调用 `application` 的 facade，不直接访问数据库。

### 2.2 前端路由与展示层（A 方案）

`app/` 使用 App Router route groups 只划分布局和页面区域，括号名称不出现在 URL 中：`(public)` 对应公开首页，`(auth)` 对应 `/login` 和 `/register`，`(learn)` 对应需要会话的学习页面。业务组件不放在 `app/` 内，而放在所属 BC 的 `presentation/`；本次落地的 `identity/presentation/` 包含表单、注销按钮、会话守卫和同源 BFF client。这样将来为 Planning 增加路线页时，只需新增 `modules/planning/presentation/`，不把业务逻辑散落到路由目录。

### 2.3 Python Agent Worker：FastAPI 目录与 DDD 的对应关系

Python Worker 使用你熟悉的 `core / schemas / services / repositories / models` 命名，但它们只服务于 **Agent 编排与资料处理**；用户、学习路线、题目和练习等核心业务仍由 `apps/web/src/modules/*` 持有。

| 常见 FastAPI 目录 | 本目录中的位置 | 在 LearnCraft 中负责什么 | 不应做什么 |
| --- | --- | --- | --- |
| `core/` | `apps/agent-worker/src/learncraft_agent/core/` | 配置、日志、内部服务鉴权、FastAPI 依赖注入 | 放学习路线、题目等业务规则 |
| `schemas/` | `interfaces/http/schemas/`、`application/dto/`；工作流专用 schema 后续放入 `workflows/` | 用 Pydantic 校验 HTTP/队列消息、LLM 结构化输出、图状态和内部 DTO | 作为数据库 ORM 模型，或直接给前端复用 Python 类 |
| `services/` | `application/services/`；纯规则另放 `domain/services/` | 组织“启动规划”“生成节点内容”等 Agent 用例 | 直接调用 FastAPI `Request`，或绕过 port 写业务表 |
| `repositories/` | `domain/repositories/`（接口）+ `infrastructure/persistence/repositories/`（SQLAlchemy 实现） | 保存 AgentRun/checkpoint 等 Agent 自有数据 | 直接写 `learning_plans`、`assessments`、`users` 等核心业务表 |
| `models/` | `infrastructure/persistence/models/` | SQLAlchemy ORM，仅映射 Agent 自有表或只读投影 | 与 Next.js 的 DDD entity/aggregate 混用 |
| `alembic/` | `apps/agent-worker/alembic/`（当前只有说明文档） | 只有 Python 成为数据库迁移的唯一所有者时才启用 | 与 Drizzle 同时迁移同一数据库/同一批表 |

#### Pydantic 与 Next.js 的边界

即使 Next.js 承担 BFF 和用户 API，Python 仍需要 Pydantic。浏览器请求由 Next.js Route Handler 用 **Zod** 校验；Next.js 与 Python Worker 之间通过 OpenAPI/JSON Schema 传递请求；Python 再用 **Pydantic** 校验 FastAPI 入参、队列消息和 LLM 输出。Pydantic DTO、Zod schema 与 ORM model 是三种不同的对象，不能相互替代。

```text
Browser ──Zod──> Next.js Route Handler / Core API
                         │ OpenAPI / JSON Schema
                         ▼
                 Python FastAPI / Agent Worker ──Pydantic──> LangGraph / Tools
```

#### 托管模型 API 与 Agent Worker 的边界

`ModelGateway` 是 `agent-worker` 内部的应用服务，不是独立 Docker 服务。后续 Provider adapter 放在 `infrastructure/llm/`，用 LangChain Provider integrations 调用已批准的托管模型 API；`application/ports/` 与 `application/services/` 决定任务该使用哪个白名单 `ModelProfile`。

```text
LangGraph workflow → ModelGateway / LLM Port → ProviderAdapter
                                                │ HTTPS + Provider API key
                                                ▼
                                         托管生成 / Embedding API
```

Provider API key、模型名称、并发/超时、单次预算与 fallback 策略只放在 `core/` 的运行时配置和部署 Secret 中，不能进入浏览器、Pydantic 对外 DTO 或领域模型。生成、embedding 与 rerank 可以使用不同 profile；Agent Worker 不得让用户传入任意 Provider、base URL 或模型参数。未来如具备稳定 GPU 基础设施，可在不改变 `LLM Port` 的前提下新增 vLLM adapter。

#### Alembic 决策（当前 MVP）

当前 MVP 以 `db/migrations/` 中的 **Drizzle 迁移作为唯一数据库迁移入口**。`apps/agent-worker/alembic/` 当前只保留一份“不得与 Drizzle 并用”的说明文档；不创建 revision、不执行 Alembic，也不单独管理 Agent 表。单人开发时不要让 Alembic 和 Drizzle 同时改同一个 PostgreSQL schema。

若未来明确把所有数据库迁移的所有权转给 Python，再启用 Alembic，并同时停用 Drizzle 迁移；这是架构决策，不是简单多加一个文件夹。

### 2.4 表/投影归属（建议）

```text
identity_*                 -> Identity/Profile
learning_plans/plan_nodes  -> Planning
content_sources/documents/chunks/embeddings -> Content
assessments/questions/attempts/masteries     -> Assessment
execution_jobs/artifacts  -> Practice
agent_runs/agent_checkpoints/outbox_events   -> Agent/平台基础设施
```

所有用户资源表必须有 `owner_id`；`tenant_id` 作为未来多租户的可选扩展，不在 MVP 引入组织权限。所有表统一维护 `created_at`、`updated_at`；聚合写入走各自 repository。`embeddings` 使用 pgvector 索引，向量维度由 embedding 模型配置统一管理，禁止在业务代码中硬编码多个维度。

## 3. 依赖规则与工程约束

1. 依赖方向固定为 `interfaces → application → domain`；`infrastructure → application/domain` 实现端口。`domain` 不依赖 Next.js、React、Drizzle/Prisma、LangChain、HTTP 或环境变量。
2. 一个 BC 不能导入另一个 BC 的 `domain`、ORM record 或内部 DTO。跨 BC 只能经 `packages/contracts`、事件总线或明确的 application facade/ACL。
3. Route Handler、Server Action 和 Graph 节点都必须是薄适配器：鉴权/解析输入后调用 command/query handler；事务、幂等和业务不变量在 application/domain。
4. Agent graph 只能通过 `CoreApiPort`、`RetrieverPort`、`ExecutionPort` 等端口工作。LLM 输出先经过结构化 schema、校验和安全策略，再调用 `persist` 工具；不能把未经校验的 JSON 直接写库。
5. 长任务采用 `202 + agentRunId`，状态写入 `agent_runs`，前端通过轮询/SSE 获取状态。每个 command 带 `idempotency_key`；领域事件经 outbox 发布，避免事务提交与消息发布不一致。
6. 查询可以使用读模型/SQL 直读，但写模型必须通过聚合。向量检索属于 Content 的 query port；Agent 默认经该 port/Core API 获取结果，不能直连核心写模型；如性能需要直连 pgvector，只能使用独立只读投影和凭据。相似度结果需带 `document_id/chunk_id/source_url`，以便引用溯源。
7. 日志禁止记录完整 prompt、用户私密资料和密钥；保留 `trace_id`、`agent_run_id`、prompt 版本、模型名、token/cost 和错误类别。
8. 测试按层分开：domain 纯单测，application 使用 fake ports，repository 做 PostgreSQL 集成测试，Agent graph 做节点/回放测试，关键流程做 Playwright E2E。
9. 浏览器/Next.js 边界用 Zod，Python FastAPI、队列消息与 LLM 结构化输出用 Pydantic；跨语言只共享 OpenAPI/JSON Schema，禁止直接共享 ORM model 或把 Pydantic class 当作前端 DTO。
10. MVP 的数据库迁移只能由 `db/migrations/`（Drizzle）执行；`agent-worker/alembic/` 在未完成“迁移所有权转移”决策前不得创建版本文件或运行。
11. 托管模型 Provider 的 API key、模型 profile、预算与 fallback 策略只配置在 `agent-worker` 的 Secret 与 `core/` 运行时配置中；浏览器、代码 Runner 和领域模型都不能持有或传入任意 Provider、base URL、模型参数或密钥。

## 4. MVP 的最小流程与入口

```text
填写画像 -> POST /api/v1/profile
         -> POST /api/v1/plans（创建 AgentRun，返回 202）
         -> Agent intake_plan graph：读取画像 -> 检索/生成 -> 校验 JSON -> Core API 持久化
         -> GET /api/v1/plans/:id（路线图卡片）
点击节点 -> POST /api/v1/nodes/:id/content（生成/检索内容包）
开始前测 -> POST /api/v1/assessments/:id/attempts -> AssessmentSubmitted
提交代码 -> POST /api/v1/executions（受限 runner） -> ExecutionCompleted
```

MVP 已使用 PostgreSQL Outbox + 独立 Dispatcher + Celery Redis Broker。Web 只在同一事务中创建 `AgentRun` 和 Outbox；Dispatcher 负责可靠投递，Celery Worker 负责执行。`AgentRun` 状态机保持异步契约，未来替换 Broker（例如托管 Redis/Sentinel 或 SQS）不影响领域层。

## 5. 演进路线

- **V1.1**：以 `AssessmentSubmitted`、`ExecutionCompleted` 为输入建立 Progress 投影和报告查询，不修改 Planning 聚合接口。
- **V1.2**：将 Content ingestion、embedding、Execution runner 拆成独立 worker；引入 Redis/SQS、对象存储和真正的容器沙箱。
- **V2**：若团队/流量增加，把 `apps/web/src/modules/*` 原样迁到独立 Core API 服务；`packages/contracts` 保持稳定，前端和 Agent 无感迁移。
- **多租户/社区**：新增 Community BC，不把帖子、评论或社交关系塞进 LearnerProfile/Planning；通过事件订阅实现成就和分享。

## 6. 建议的第一批提交顺序

1. 建立 `packages/contracts`、数据库迁移骨架和 `shared` 原语。
2. 实现 Identity/Profile、Planning 两个 BC 的 domain/application/repository，以及画像→创建路线图的假 Agent 流程。
3. 接入 Python Agent 的 `intake_plan` graph（节点契约采用 InputNormalizer→Assessment→PlanPlanner→Validator）和 Core API ACL；加入 AgentRun 状态查询。
4. 加入受控 Content URL/Markdown ingestion + pgvector 检索，再接节点内容生成。
5. 加入 Assessment 前测和最小 Practice runner；最后补 E2E、限流、审计和可观测性。
