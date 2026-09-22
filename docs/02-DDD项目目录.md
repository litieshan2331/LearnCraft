# LearnCraft MVP：DDD 项目目录与边界设计

> **Agent 侧技术栈变更（2026-09-16）：**Agent 侧已确认由 Python 迁移到 TypeScript/Node.js，**不保留 Python 运行时**。本文保留的领域边界、依赖规则与演进路线**与实现语言无关，继续有效**；迁移前的目录树、Python 工程结构与已完成的实施描述均已删除，当前实现以 TypeScript 工程与 [09-全栈TypeScript迁移方案](./09-全栈TypeScript迁移方案.md) 的待办清单为准。

> **当前范围决策更新（2026-08-23，优先于本文后续所有 P0 描述）：**
>
> - `LearningPlan` 包含 6–12 个按依赖排序的主题节点；`PlanNode` 不再表达四阶段，而是承载一个可独立学习的知识主题。
> - 学习规划 Agent 只创建路线；节点教学 Agent 在节点首次打开时按需生成唯一内容，并以 `foundation`、`worked_example`、`pitfalls_debug` 三段式内容合同交接给前端。
> - `worked_example` 是页面内可读代码示例，含调用顺序、预期输出和解释；P0 不再要求代码文件、依赖、运行命令或本地运行。
> - 用户阅读后可标记已学完，并自行选择是否生成节点后测；后测不再作为内容生成或阅读完成后的自动步骤。
>
> 本更新取代本文中关于 `concept/syntax/practice/debug`、`LocalDemo` 与强制节点后测的旧约定。
>
> **内容合同更新（2026-09-22）：**节点内容合同已从 `card_content.v1` 升级为 `card_content.v2`：`worked_example.files[]` 逐文件承载代码（path / language / role / content，1–8 个文件），配 `entry_file` 与 `call_sequence[]`（step / file / function / note），`expected_output` 仍为单个字符串。页面以“左侧目录树 + 右侧代码”呈现并做语法高亮（Shiki）。历史 v1 内容只在读取侧兼容，不重新生成。

> **范围决策更新（2026-08-16，优先于本文其他 P0 描述）：**`Practice Execution` 在 P0 仅持有本地 Demo 内容产物的领域契约，不创建 `ExecutionJob`，不提供在线执行接口，也不启动 Runner 容器。Demo 必须包含代码文件、中文注释、入口、依赖与本地运行步骤、预期输出和调用顺序；真正的 Sandbox、`ExecutionJob`、stdout/stderr 和资源隔离后置 P1。`practice/` 目录与 Runner port 保留为 P1 扩展边界。
>
> 用户只有一份可编辑的 `LearnerProfile`；新目标和尚未生成的内容读取最新画像。前测、学习计划和已生成内容各自保存 `profile_version` 与必要输入快照，确保既有产物可追溯。每个目标只允许一份有效前测；评分后先向本人展示答案与解析，再由用户显式触发学习计划生成。每个计划节点只允许一份成功内容与本地 Demo；节点后测可以生成多份独立题集，保留历史作答和错题解析。学习计划节点允许用户任意进入，不以线性解锁作为访问前提。

> 本文件只描述领域边界、依赖规则与演进路线。采用“Next.js BFF/界面 + 独立 Agent Worker”的模块化单体形态：业务聚合由 `apps/web` 统一持有，Agent 只负责工作流编排和工具调用。Agent 侧目标实现语言为 TypeScript（迁移前仍为 Python），业务领域模型始终只在 `apps/web/src/modules/*` 实现一次。
>
> 文档状态：实施中｜更新日期：2026-07-26
>
> 配套文档：[Agent 架构设计](./05-Agent架构设计.md) · [全栈 TypeScript 迁移待办](./09-全栈TypeScript迁移方案.md)

## 1. MVP 的边界上下文

| Bounded Context | 类型/优先级 | 负责什么 | MVP 状态 |
| --- | --- | --- | --- |
| Identity & Learner Profile（身份与学习者画像） | 支撑 | 用户、整体编程背景、可用时间、内容偏好 | 必须；每用户仅一份当前画像 |
| Learning Planning（学习规划） | 核心 | 学习目标、路线图、四阶段节点、节点状态和依赖 | 必须 |
| Learning Content（学习内容与知识库） | 核心 | 受控资料目录、URL/文档导入、解析、切块、摘要、向量索引、内容包 | 必须（P0 用人工审核资料；URL/Markdown/PDF 受控入口为 P1） |
| Model Connection（用户模型连接） | 支撑 | 用户 OpenAI-compatible Base URL、加密 API Key 与账户默认模型 | 必须（P0 所有生成任务使用账户默认连接；仅公网 HTTPS 域名；Worker 通过受控出网层实际调用） |
| Assessment（前测与后测） | 核心 | 单选题、答题、确定性评分与薄弱点 | 必须；前测 10–20 题，节点后测 5–10 题，可重新生成后测练习，不含简答题 |
| Practice（本地代码 Demo） | 核心差异化 | 代码文件、运行说明、调用顺序与结果解释 | P0 只生成本地 Demo 内容；`Practice Execution`、运行日志与安全策略是 P1 Sandbox 的边界 |
| Agent Orchestration（Agent 编排） | 通用技术上下文 | 学习规划 Agent、节点教学 Agent、结构化交接快照、运行状态、重试、检查点、提示词/Profile 版本、工具调用 | 必须，但不拥有学习业务聚合；两个 Agent 运行在同一 Worker，不是两个常驻进程 |
| Progress & Report（进度与报告） | 支撑 | 进度条、学习报告、成就 | V1.1+，由领域事件消费 |
| Community（社区） | 支撑 | 分享、讨论、社群 | 后续 |

### 1.1 聚合与领域事件（MVP 最小集合）

- **LearnerProfile**（聚合根）：`LearnerId`、整体编程背景、每周可用时间、`ContentPreference` 与单调递增的 `ProfileVersion`。发布 `LearnerProfileCompleted`；后续变更只更新当前画像，不改写已经生成的产物。
- **LearningPlan**（聚合根）：`PlanId`、`LearnerId`、目标、生成时的画像版本与输入快照、版本、状态；内部 `PlanNode` 实体包含阶段（`concept/syntax/practice/debug`）、顺序、前置节点、预计时长、状态和由学习规划 Agent 写出的自然语言 `node_brief`。发布 `LearningPlanRequested`、`LearningPlanGenerated`；前置关系用于学习建议与展示，不作为节点访问锁。
- **ContentSource/ContentDocument**（聚合根）：来源 URL/上传文件、抓取状态、清洗后的文档和 `ContentChunk`；向量是投影而非领域实体。发布 `ContentIngested`、`ContentIndexed`。
- **Assessment**（聚合根）与 **Attempt**（高并发时独立聚合）：前测/节点后测、单选题、首次生成时即保存的隐藏答案和解析、用户答案、确定性评分与薄弱点。前测 10–20 题且每目标只能成功生成一份；节点后测 5–10 题，可创建多份独立题集用于练习。交卷前不返回答案/解析，交卷后仅向所有者返回；后测历史保留题集、作答、错题和解析。发布 `AssessmentSubmitted`、`AssessmentScored`。
- **LocalDemo**（`CardContent` 的值对象）：代码文件、运行时版本、入口、依赖、运行步骤、预期输出、调用顺序、中文注释和常见报错排查。每个节点在 P0 只保存一份成功 `CardContent`/Demo；内部 `teaching_memory` 是后测的结构化出题依据。P0 不创建 `ExecutionJob`；该聚合及 `ExecutionCompleted`/`ExecutionFailed` 事件留给 P1 在线 Sandbox。
- **AgentRun**（编排上下文聚合根）：工作流类型、关联业务对象、状态、幂等键、错误和 token 用量。`run_type` 派生 `learning_architect` 或 `node_tutor` 角色，`target_type + target_id` 即逻辑会话范围；输入/输出摘要保存结构化交接快照而非原始聊天记录。它记录“如何执行”，不决定“什么是合格的学习计划”。发布 `AgentRunStarted`、`AgentRunSucceeded`、`AgentRunFailed`。

MVP 先将 `LearningPlan` 内的节点作为实体保存；节点很多或需要独立协作时，再拆成 `PlanNode` 聚合。`ContentChunk` 和向量索引仅作为文档的读模型/基础设施数据，不能被 UI 直接改写。

### 1.2 上下文映射

```text
Identity/Profile ──(profile DTO)──> Learning Planning
Learning Planning ──(node/content request)──> Learning Content
Learning Planning ──(assessment request)──> Assessment
Assessment ──(front assessment scored)──> Learning Planning
Learning Content ──(retrieval port)──> Agent Orchestration
Assessment/Planning/Content <──(ACL + internal API)── Agent Orchestration
All contexts ──(domain events/outbox)──> Progress & Report (later)
```

Agent 通过 Anti-Corruption Layer（ACL）调用 Core API/应用服务；不能直接 import `LearningPlan` 的领域类，也不应绕过应用服务写核心表。上下文之间只传版本化 DTO/事件，不共享 ORM Model。检索适配器默认调用 Content 的只读 query port；若为性能需要直连 pgvector，只能使用独立只读凭据和 Content 投影 schema，禁止读取/修改业务写模型。

## 3. 依赖规则与工程约束

1. 依赖方向固定为 `interfaces → application → domain`；`infrastructure → application/domain` 实现端口。`domain` 不依赖 Next.js、React、Drizzle/Prisma、LangChain、HTTP 或环境变量。
2. 一个 BC 不能导入另一个 BC 的 `domain`、ORM record 或内部 DTO。跨 BC 只能经 `packages/contracts`、事件总线或明确的 application facade/ACL。
3. Route Handler、Server Action 和 Graph 节点都必须是薄适配器：鉴权/解析输入后调用 command/query handler；事务、幂等和业务不变量在 application/domain。
4. Agent graph 只能通过 `CoreApiPort`、`RetrieverPort` 等端口工作。LLM 输出先经过结构化 schema、校验和安全策略，再调用 `persist` 工具；不能把未经校验的 JSON 直接写库。`ExecutionPort` 是 P1 在线 Sandbox 的预留端口，不在 P0 实现。
5. 长任务采用 `202 + agentRunId`，状态写入 `agent_runs`，前端通过轮询/SSE 获取状态。每个 command 带 `idempotency_key`；领域事件经 outbox 发布，避免事务提交与消息发布不一致。
6. 查询可以使用读模型/SQL 直读，但写模型必须通过聚合。向量检索属于 Content 的 query port；Agent 默认经该 port/Core API 获取结果，不能直连核心写模型；如性能需要直连 pgvector，只能使用独立只读投影和凭据。相似度结果需带 `document_id/chunk_id/source_url`，以便引用溯源。
7. 日志禁止记录完整 prompt、用户私密资料和密钥；保留 `trace_id`、`agent_run_id`、prompt 版本、模型名、token/cost 和错误类别。
8. 测试按层分开：domain 纯单测，application 使用 fake ports，repository 做 PostgreSQL 集成测试，Agent graph 做节点/回放测试，关键流程做 Playwright E2E。
9. 浏览器/Next.js 边界用 Zod；Agent Worker 侧迁移前用 Pydantic、迁移后统一用 Zod 校验队列消息与 LLM 结构化输出。接口与事件只通过 OpenAPI/JSON Schema 共享，禁止直接共享 ORM model 或把校验 DTO 当作前端 DTO。
10. 用户 Provider API Key 只经模型连接 API 写入，以 AES-256-GCM 密文存储；`CREDENTIAL_ENCRYPTION_KEY` 仅由 Web 与实际模型 Worker 的 Secret 持有。浏览器响应、内容产物、Outbox、队列消息和领域事件均不得持有明文 Key；任务只能传受信任的连接 ID/模型名。Base URL 仅允许公网 HTTPS 域名/443；真实调用只能经 `SafeModelEgressClient` 的 DNS/IP/重定向/审计策略，生产环境还必须配置受控 egress proxy。

## 5. 演进路线

- **V1.1**：以 `AssessmentScored`、节点完成事件为输入建立 Progress 投影和报告查询，不修改 Planning 聚合接口。
- **V1.2**：将 Content ingestion、embedding、在线 Sandbox 拆成独立 worker；引入 Redis/SQS、对象存储和真正的容器沙箱。
- **V2**：若团队/流量增加，把 `apps/web/src/modules/*` 原样迁到独立 Core API 服务；`packages/contracts` 保持稳定，前端和 Agent 无感迁移。
- **多租户/社区**：新增 Community BC，不把帖子、评论或社交关系塞进 LearnerProfile/Planning；通过事件订阅实现成就和分享。

