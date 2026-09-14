# LearnCraft 全栈 TypeScript 迁移方案

> 文档状态：迁移设计，尚未实施  
> 更新日期：2026-09-13  
> 目标：除经确认必须保留的特殊数据处理能力外，将 LearnCraft 的 Web、异步投递、Agent 编排、模型调用与工具调用统一为 TypeScript/Node.js；Agent 采用 LangGraph.js 与 LangChain.js 重建。  
> 本文不修改数据库 Schema、应用代码、Docker Compose、环境变量或生产服务。所有“待确认”项必须在相应实施阶段开始前再次确认。

## 1. 结论与范围

目标不是把 Agent 代码塞入 Next.js 的 Route Handler，而是将其改造成与 Web 同语言、但仍独立部署的 Node.js/TypeScript Worker。这样可以统一语言、类型系统、依赖管理、测试工具与部署镜像，同时保留长任务不阻塞 HTTP 请求、可靠投递、失败重试和最小权限出网等已有边界。

迁移完成后的常态架构为：

```text
Browser
  │ HTTPS
  ▼
Next.js Web / Core API（TypeScript）
  │  创建 AgentRun + Outbox（同一 PostgreSQL 事务）
  ▼
PostgreSQL Outbox
  ▼
TypeScript Dispatcher
  ▼
Redis 队列
  ▼
TypeScript Agent Worker（LangGraph.js + LangChain.js）
  ├─ 用户选择的 OpenAI-compatible Provider
  ├─ Tavily MCP
  └─ Web 内部 API

特殊数据处理 Worker（仅在确有必要时保留 Python）
  └─ 例如受限文档解析、OCR、特定科学计算；通过版本化任务契约与 TS 系统通信
```

本次目标包括：

- 以 TypeScript 重建 `assessment_generate`、`plan_generate`、`card_content_generate`、`posttest_generate` 四个 AgentRun 工作流；
- 以 LangGraph.js 显式表达生成、工具调用、校验、修复、最终兜底和持久化的状态流转；
- 以 LangChain.js 或其底层 `@langchain/core` 适配模型、消息与工具；
- 将 Python Celery Dispatcher/Worker 替换为 TypeScript Dispatcher/Worker；
- 保持 AgentRun、Outbox、Core 内部 HTTP 契约、业务结果、权限边界与安全规则的行为兼容；
- 对纯 CPU 密集的 TypeScript 工作使用受控的 Node.js `worker_threads` 池，而非阻塞 Agent Worker 的事件循环。

本次目标不包括：

- 更改学习目标、路线、题集、卡片内容等领域规则；
- 修改用户 API Key 的保存格式、明文暴露范围或安全策略；
- 在浏览器或 Next.js 请求进程中执行长时间模型调用；
- 将未经批准的 MinerU、OCR、GPU 推理或数据科学能力强行改写为 TypeScript；
- 以“重写”为由顺手改变数据库 Schema、Prompt、模型预算、工具预算或产品流程。

## 2. 当前基线与迁移依据

当前仓库的实际实现是：

| 当前部分 | 当前实现 | TypeScript 目标 |
| --- | --- | --- |
| Web/Core | Next.js、React、TypeScript、Drizzle、`pg` | 保持，仍是领域事实源和唯一公网入口 |
| AgentRun 创建 | Web 事务内创建 `agent_runs`、`agent_run_events`、`outbox_events` | 行为、表和事件契约优先保持不变 |
| 可靠投递 | Python Dispatcher 以 `FOR UPDATE SKIP LOCKED` 领取 Outbox，再投递 Celery Redis | TypeScript Dispatcher 重建同一领取语义，投递新的 TypeScript 队列 |
| 长任务执行 | Python Celery Worker，当前默认并发为 1 | Node.js Worker 进程，I/O 并发与进程副本数均由显式配置控制 |
| Agent 工作流 | Python 异步 Workflow、`ToolAwareGenerator`、Pydantic 校验 | LangGraph.js `StateGraph` + Zod 运行时校验 + 等价工具循环 |
| 模型调用 | OpenAI-compatible SSE、固定 IP 出网、SNI、响应大小限制、审计 | TypeScript `ModelGateway`，安全性质必须逐项等价 |
| 工具 | Tavily 远程 MCP、调用次数和每日额度限制 | TypeScript MCP Tool Gateway，保留额度、白名单和工具循环规则 |
| 业务写入 | Worker 调 Web 私有内部 API，不能直写核心表 | 保持 |
| 特殊数据处理 | Python 包已为文档解析、embedding、检索等预留目录 | 先判定是否真需 Python；需要时缩成独立、受限的数据处理服务 |

有两个需要如实区分的事实：

1. Python 项目依赖中已包含 LangChain/LangGraph，但当前 `src` 没有实际使用 `StateGraph`，`infrastructure/checkpoint/` 也只有占位说明，尚未接入生产 Checkpointer。因此迁移不是“逐行翻译现有 LangGraph Python 图”，而是以当前已运行的异步 Workflow 行为为准，首次显式建模为 LangGraph.js 图。
2. 当前 Worker 默认 `CELERY_WORKER_CONCURRENCY=1`，这是部署限额，不是 Python 的语言上限。迁移后也必须用显式的队列并发、Provider 限流、进程副本和资源上限控制容量，不能假设 TypeScript 会自动扩大吞吐。

## 3. 目标架构原则

### 3.1 仍然是“模块化单体 + 独立 Worker”

Web 和 Agent 统一为 TypeScript，不表示二者合并为同一个进程：

- `apps/web`：Next.js 页面、BFF、领域应用服务、认证、授权、业务事务和内部 HTTP 接口；
- `apps/agent-worker`：不暴露公网的 Node.js Worker，消费队列，执行 LangGraph.js 工作流；
- `apps/agent-dispatcher` 或 Agent Worker 的独立 Dispatcher 入口：领取 Outbox 并投递队列；
- `apps/data-processor`：仅在确认某种能力无法合理迁移到 TypeScript 时存在的专用处理器。它不承担通用 Agent 编排，不持有用户模型密钥，也不直写核心业务表。

Node.js Agent Worker 必须是独立容器或独立进程。Next.js 的请求生命周期、内存空间、发布重启频率和公网暴露面都不适合承载最长 600 秒的 AgentRun。

### 3.2 保持不变的边界

以下边界是迁移验收条件，不因语言更换而放宽：

- 创建 AgentRun、运行事件和 Outbox 必须仍在同一 PostgreSQL 事务内；
- 队列消息只含 `agent_run_id`、`trace_id`、版本等最小元数据，不得含 Prompt、用户资料、模型 API Key 或模型原始输出；
- Agent 只能更新自身运行状态；学习计划、题集和卡片内容必须仍经 Web 内部 API 幂等写入；
- 用户模型 API Key 继续只以 AES-256-GCM 密文保存，浏览器、队列、日志和业务结果均不可获得明文；
- Provider 地址继续拒绝 IP 字面量、localhost、私网与重定向；生产模型访问继续经过受控 egress proxy；
- 浏览器继续只看到 AgentRun 状态和已通过校验的最终产物，不能看到未校验的模型 Token 流；
- 重试、取消、超时、幂等、审计、工具调用上限与每日额度必须保留等价语义。

### 3.3 TypeScript 的并发分层

将三种并发明确分开，避免把 Worker Threads 当作所有并发问题的解决方案：

| 层次 | 适用工作 | 推荐机制 | 不适用场景 |
| --- | --- | --- | --- |
| AgentRun I/O 并发 | LLM SSE、Tavily、PostgreSQL、内部 HTTP | BullMQ Worker 的异步 `concurrency` + 多个 Node Worker 副本 | 同步 CPU 重计算 |
| CPU 并行 | 大文本纯计算、压缩、可迁移的解析或批处理 | 有界 `node:worker_threads` 池 | 长时间 LLM 请求、数据库事务、直接执行业务工作流 |
| 进程级扩展 | 高可用、隔离、跨机器扩容 | 多容器/多实例 Worker | 共享内存计算 |

Node 官方说明 Worker Threads 适合 CPU 密集型 JavaScript，不会显著改善 I/O 密集任务；I/O 应由异步操作处理。[Node.js Worker Threads 文档](https://nodejs.org/api/worker_threads.html) BullMQ 也区分异步任务的本地 `concurrency` 与 CPU 重任务应采用隔离 processor 的情况。[BullMQ 并发文档](https://docs.bullmq.io/guide/workers/concurrency)

对于本项目，AgentRun 主流程默认属于 I/O 密集型：模型流式请求、工具访问和内部 API 均应在普通异步 Worker 中运行。`worker_threads` 只接收无密钥、可序列化、可取消、CPU 边界清晰的输入，并配置固定池大小、单任务内存限制、超时和结果大小限制。不得每个 AgentRun 临时创建一个线程。

## 4. 推荐的运行时与依赖边界

以下是目标依赖类别，不在本文中锁定具体版本；实施时必须将精确版本写入 `package.json` 和 `pnpm-lock.yaml`，不能使用 `latest`。

| 用途 | 推荐依赖或 Node 内置能力 | 使用原则 |
| --- | --- | --- |
| 图编排 | `@langchain/langgraph`、`@langchain/core` | 用 `StateGraph` 明确节点、条件边、重试和状态；不把工作流藏在单个巨大函数中 |
| 模型与工具抽象 | `langchain`、`@langchain/core` | 封装在自定义 `ModelGateway` / `ToolGateway` 后；业务工作流不直接依赖某一个 Provider SDK |
| Schema | Zod | HTTP、队列、模型结构化输出和内部 DTO 均做运行时校验；TypeScript 类型不能替代校验 |
| 队列 | **建议 BullMQ** + Redis | 作为 Celery 的 TypeScript 替代；必须保留至少一次投递与数据库幂等边界 |
| PostgreSQL | 现有 `pg`、Drizzle 或最小参数化 SQL | Dispatcher 使用事务与 `SKIP LOCKED`；Agent 基础设施只访问获授权的表 |
| HTTP/SSE | Node 内置 `fetch`/`undici` 或经过验证的底层客户端 | 先完成“固定 IP + 原域名 SNI + 代理”安全 PoC 后才选定；不得为方便而退化为普通 `fetch(baseUrl)` |
| CPU 池 | `node:worker_threads` | 只供受控 CPU 子任务；与 BullMQ 主 I/O Worker 分层 |

LangGraph.js 是面向长运行、有状态 Agent 的低层编排框架，适合在本项目中明确建模状态、节点、条件转移与持久化；LangChain.js 可用于模型与工具组件，但不是必须由它接管所有业务逻辑。[LangGraph.js 概览](https://docs.langchain.com/oss/javascript/langgraph/overview) LangGraph.js 的 Checkpointer 通过 `thread_id` 持久化不同工作流线程；本项目应使用稳定的业务逻辑会话键，而不是浏览器会话 ID。[LangGraph.js Checkpointer 文档](https://langchain-ai.github.io/langgraphjs/reference/modules/langgraph-checkpoint.html)

## 5. 目标目录设计

以下是迁移完成后的目标形态，不代表立即创建这些目录。迁移期间应先创建并行的 TypeScript Worker 目录，待切换完成和 Python 退役后再决定是否回收或重命名旧目录，避免覆盖用户现有实现。

```text
apps/
├─ web/                                      # 继续作为 Next.js UI + Core API
├─ agent-worker/                             # 最终的 TypeScript Agent Worker
│  └─ src/
│     ├─ bootstrap/                          # 进程启动、配置、依赖装配、优雅关闭
│     ├─ dispatcher/                         # Outbox 领取与队列发布
│     ├─ queue/                              # BullMQ producer、consumer、重试映射
│     ├─ application/
│     │  ├─ commands/                        # 执行 AgentRun 的用例入口
│     │  ├─ ports/                           # Core API、模型、工具、运行库、时钟等接口
│     │  └─ services/                        # 生命周期、工具循环、预算与取消服务
│     ├─ workflows/                          # 四个 LangGraph.js 图与其状态定义
│     ├─ schemas/                            # Zod 输入、输出、Provider、事件 Schema
│     ├─ acl/                                # Web 内部 DTO 与 Agent DTO 的防腐转换
│     ├─ infrastructure/
│     │  ├─ database/                        # AgentRun、事件、Outbox 基础设施访问
│     │  ├─ llm/                             # 安全出网与 OpenAI-compatible Gateway
│     │  ├─ mcp/                             # Tavily Remote MCP 适配器
│     │  ├─ security/                        # 密钥解密和安全辅助逻辑
│     │  ├─ observability/                   # 日志、指标、追踪
│     │  └─ cpu/                             # 有界 Worker Threads 池，仅纯 CPU 任务
│     └─ main/                               # dispatcher、worker、health 等命令入口
└─ data-processor/                           # 可选：仅经确认无法迁移的 Python 特殊处理
packages/
├─ contracts/                                # 继续作为 HTTP/事件契约唯一事实源
├─ agent-contracts/                          # 可选：由 JSON Schema/OpenAPI 生成或包装的 TS DTO
└─ security-primitives/                      # 可选：无业务依赖的 AES-GCM 格式/校验共享库
```

`apps/agent-worker` 的最终目录名、是否新建 `packages/security-primitives`、以及 Python 目录的归档方式都涉及仓库结构调整；在真正创建或移动文件前必须确认。核心目标是避免 Web 直接 import Worker 的基础设施实现，也避免 Worker import Web 的 ORM 模型。

## 6. 队列与可靠投递设计

### 6.1 推荐方案：PostgreSQL Outbox + TypeScript Dispatcher + BullMQ

推荐保留 PostgreSQL Outbox，但以 BullMQ 替代 Celery：

```text
Web 事务
  ├─ INSERT agent.agent_runs
  ├─ INSERT agent.agent_run_events (run.queued)
  └─ INSERT public.outbox_events (agent.run.requested.v1)
          │
          ▼
TypeScript Dispatcher
  ├─ SELECT ... FOR UPDATE SKIP LOCKED
  ├─ 校验 agent-run-requested.v1 JSON Schema
  ├─ Queue.add("agent.run", 最小载荷, 重试/退避选项)
  └─ 成功后将 Outbox 标记 published
          │
          ▼
TypeScript Agent Worker
  ├─ beginExecution：锁定 AgentRun，领取或拒绝重复任务
  ├─ 执行 LangGraph.js 工作流
  └─ 通过 Core 内部 API 持久化业务结果，再标记运行成功/失败
```

BullMQ 的异步 Worker 可设置每个进程的 `concurrency`，也可运行多个 Worker 进程；自动重试与指数退避由 Job 选项提供。[BullMQ Worker 文档](https://docs.bullmq.io/guide/workers/) [BullMQ 重试文档](https://docs.bullmq.io/guide/retrying-failing-jobs)

但是，队列只负责“至少一次交付”，不能当作唯一幂等保障。必须继续由 PostgreSQL 中 `agent_runs` 的行锁和状态机决定某个 `agent_run_id` 是否允许执行、恢复或结束。特别是“任务已加入 Redis、但 Dispatcher 尚未写回 Outbox”为正常故障窗口，重投时不能生成两份题集或两份卡片内容。

### 6.2 Redis 隔离与并发配置

迁移期间，不允许让 Celery 与 BullMQ 共享相同的 Redis 键前缀、队列名或延迟任务数据结构。建议：

- 继续使用独立于认证 Redis 的队列 Redis；
- 为 BullMQ 设定新的、显式配置的键前缀，例如 `learncraft:agent-queue:`；
- `agent.run` 仍只是业务队列概念，实际 Redis 数据结构不可与 Celery 混用；
- 初始 `AGENT_WORKER_CONCURRENCY=1`，并以单独环境变量控制；
- 初始运行 1 个 Worker 副本，完成压测后分别调整“副本数”和“单副本异步并发”；
- 配置全局或按用户的 Provider 并发/速率限制，不能只提高本地 Worker 并发；
- 队列保留策略、完成/失败 Job 的清理、死信审计和 Redis 内存上限必须在实施时明确。

### 6.3 取消、超时与重试

迁移后需要保持以下语义：

| 行为 | 目标语义 |
| --- | --- |
| 用户取消 | 取消 AgentRun 状态；Worker 在每个安全边界检查取消，并通过 `AbortController` 中断未完成的 HTTP/SSE 请求；不强制杀死正在提交业务事务的进程 |
| 网络/429/5xx | 被分类为可重试错误，执行固定上限和指数退避 |
| Schema/权限/输入错误 | 被分类为不可重试错误，记录安全错误码并结束 |
| AgentRun 硬超时 | 先中止外部请求、清理资源、记录失败；不得简单让 Node 线程无限运行 |
| Worker 异常退出 | 队列可重新交付；数据库状态机防止重复写业务结果 |

BullMQ 的 CPU-heavy sandboxed processor 可使用 Worker Threads，但其官方也提醒：每个线程仍需复制 Node 运行时，且这种隔离主要是为避免 CPU 占满队列 Worker 的事件循环。[BullMQ Sandboxed Processors 文档](https://docs.bullmq.io/guide/workers/sandboxed-processors) 因此它不应成为普通 AgentRun 的默认执行模式。

## 7. Agent 逻辑到 LangGraph.js 的映射

### 7.1 共享执行壳

当前 Python 的 `execute_agent_run`、`BaseAgent`、`ToolAwareGenerator` 和 Repository 生命周期将映射为以下 TypeScript 层次：

| 当前行为 | TypeScript 目标职责 |
| --- | --- |
| `execute_agent_run` | `ExecuteAgentRunCommand`：领取运行、检查取消、按 `run_type` 路由、归类错误、标记终态 |
| `BaseAgent` 工作流注册 | `WorkflowRegistry`：只映射允许的 `run_type` 到已编译的 LangGraph.js 图 |
| `ToolAwareGenerator` | `ToolCallingLoop` 节点或受控子图：累计 token、限制工具次数、回填 tool message、达到上限后禁用工具 |
| Pydantic DTO/输出合同 | Zod Schema：入站载荷、工作流输入、模型输出、工具结果、内部 API 响应 |
| `WebCoreInternalClient` | `WebCoreInternalClient` TypeScript ACL：保留超时、响应分类、共享服务密钥和幂等请求语义 |
| `SqlAlchemyAgentRunRepository` | `PgAgentRunRepository`：使用参数化 SQL/Drizzle，保留行锁、事件序号和状态迁移 |

所有图都以结构化输入快照开始，以“已校验、可持久化”的业务结果结束。不得把无限历史 Prompt 或 Provider 原始 SSE 片段写入图状态、数据库或浏览器。

### 7.2 标准图状态

每个工作流可拥有自己的精确 Schema，但建议有以下受限共享状态概念：

```text
AgentGraphState
├─ run：agent_run_id、owner_id、run_type、trace_id、逻辑会话键
├─ input：已经 Zod 校验的输入快照
├─ connection：仅运行内使用的模型连接/密钥句柄，不写日志或 Checkpoint
├─ messages：受限长度的 Provider 消息；不得保存用户密钥
├─ tool_call_count：累计工具调用次数
├─ generation：模型文本、使用量、恢复阶段、脱敏校验路径
├─ validated_output：通过业务 Schema 的最终结果
└─ error：稳定错误码、可重试标识、不可含原始敏感正文
```

`connection.apiKey` 不得进入可持久化 Checkpoint。若 LangGraph.js 后续启用持久化 Checkpointer，应将密钥排除在 state 中，只在节点执行时根据 `agent_run_id` 重新从 Web 内部 API 获取并解密。

### 7.3 四个工作流的对应关系

| `run_type` | 现有 Python 行为 | LangGraph.js 目标节点 |
| --- | --- | --- |
| `assessment_generate` | 读取默认模型连接；按需 Tavily；生成 10–20 道前测；结构校验、修复和持久化 | `load_input` → `load_connection` → `generate_or_tool_loop` → `validate_question_set` → `repair` / `tavily_recovery` → `persist_assessment` |
| `plan_generate` | 读取目标、画像与前测快照；生成 6–12 节点路线；校验图依赖和持久化 | `load_input` → `load_connection` → `generate_or_tool_loop` → `validate_plan` → `repair` / `tavily_recovery` → `persist_plan` |
| `card_content_generate` | 读取节点/画像/路线快照；按需 Tavily；生成 `foundation`、`worked_example`、`pitfalls_debug` 等合同 | `load_input` → `load_connection` → `generate_or_tool_loop` → `validate_card` → `repair` / `source_rebuild` → `persist_card_content` |
| `posttest_generate` | 读取已固定卡片内容与 `teaching_memory`；生成 5–10 道后测；校验和持久化 | `load_input` → `load_card_context` → `load_connection` → `generate_or_tool_loop` → `validate_question_set` → `repair` / `tavily_recovery` → `persist_assessment` |

“修复”和“最终 Tavily 兜底”必须保留当前的受控次数与条件，不能由于使用 LangGraph.js 就变成无限循环。LangGraph.js 图应通过明确的条件边根据 `validated_output`、错误类别和尝试次数转移；节点可以是普通 TypeScript 函数，图负责状态演进和可视化。[LangGraph.js Graph API 文档](https://docs.langchain.com/oss/javascript/langgraph/graph-api)

### 7.4 模型与工具调用

在工作流上层保留自定义 Port，而不是让业务代码直接调用 LangChain Provider：

```text
Workflow
  → ModelGateway Port
      → SafeModelEgressClient
          → OpenAI-compatible SSE Provider

Workflow
  → ToolGateway Port
      → Tavily Remote MCP
```

`ModelGateway` 的等价验收项包括：

- 所有真实生成请求继续发送 `stream=true`，但先在 Worker 内安全聚合完整 SSE，再进行 JSON 提取和 Zod 校验；
- 连接超时、读取超时、响应大小、重定向禁止、429/5xx 重试分类与当前配置等价；
- 继续支持 OpenAI-compatible Chat Completions、工具调用、`response_format: json_object`、DeepSeek 私有思考参数的受限适配；
- Provider 原始响应、Prompt 和 API Key 不写入日志、AgentRun 或队列；
- 工具调用只暴露 Tavily 白名单，累计调用次数不超过 `AGENT_TOOL_MAX_CALLS`；额度 Redis 不可用时不得绕过限制访问网络。

## 8. 最关键的安全迁移：受控模型出网

当前 Python `SafeModelEgressClient` 做了比普通 SDK 调用更严格的工作：验证 URL 与全部 DNS 结果、拒绝私网地址、以已验证 IP 作为连接目标、保留原域名 TLS SNI、禁止重定向、限制响应大小，并写入最小审计记录。

这部分不能用下面这种写法替代：

```ts
// 禁止作为实现方案：会把域名再次交给默认连接层解析，无法证明等价的 SSRF 防护。
await fetch(`${userSuppliedBaseUrl}/chat/completions`);
```

在正式迁移模型调用前，必须完成 TypeScript 安全 PoC，并以自动化测试证明至少以下性质：

1. 用户 Base URL 只能是允许的公网 HTTPS 域名和端口；
2. 每次调用解析全部 DNS 地址，任一非法地址即拒绝；
3. TCP 或 CONNECT 目标固定为已验证 IP，TLS SNI/Host/证书校验仍对应原域名；
4. 禁止 HTTP 重定向、IP 字面量、私网、环回、链路本地和云 metadata 地址；
5. 生产只能通过确认过的 egress proxy；
6. 流式和非流式响应均按字节数上限读取，错误和审计记录不含密钥、Prompt 或模型正文；
7. DNS rebinding、分块 SSE、异常断流、429、5xx、超大响应和代理失败均有回归测试。

只有在安全 PoC 通过后，才可选择 Node `fetch`/`undici` 的具体 Dispatcher、HTTPS Agent 或代理实现。若不能证明“固定 IP 连接同时保持原域名 TLS 验证”，则不得上线 TS 模型 Worker。

## 9. Checkpoint、会话与特殊数据处理

### 9.1 Checkpoint 策略

当前仓库仅预留 Python Checkpoint 目录，未发现已接入的生产 Checkpointer。因此第一阶段的 TS 行为目标是保持现有 AgentRun 状态、运行事件、重试与幂等，不应声称已经具备跨节点恢复。

若要在迁移中新增 LangGraph.js PostgreSQL Checkpointer，属于新的持久化行为和可能的数据库 Schema 变更，必须先确认：

- 使用的 Checkpointer 包、精确版本和表结构；
- `thread_id` 命名规则：学习规划使用 `learning_architect:{goal_id}`，节点教学使用 `node_tutor:{plan_node_id}`；
- 保留期、删除/隐私策略、状态加密与敏感字段排除；
- 异常恢复、兼容升级和回放权限；
- 是否与现有 `agent.agent_runs` 形成独立表，及迁移/回滚方案。

在上述决策确认前，LangGraph.js 可使用无持久化图执行，状态仍以 AgentRun、业务快照和幂等持久化为事实来源。

### 9.2 特殊 Python 数据处理的收口原则

“除特殊数据处理外全 TS”必须在实施前列出允许保留 Python 的白名单，而不能让新的 Python Agent 逻辑继续扩张。推荐规则：

- 可迁移到 TS 且仅涉及 HTTP、JSON、业务规则、LLM、工具、队列、PostgreSQL 的功能，一律迁入 TS；
- 确有生态依赖的文档解析/OCR/科学计算，可留在 Python `data-processor`；
- Python 处理器以版本化 HTTP 或独立队列契约接收对象存储 URI/任务 ID，返回结构化元数据；
- Python 处理器不读取用户模型连接、不执行 LangGraph、不处理 Web 会话、不直写核心业务表；
- 每种保留能力要有负责人、替代评估日期、资源上限和安全边界。

## 10. 分阶段实施计划

以下阶段按顺序执行。每个阶段都必须通过验收后才进入下一阶段；本文只描述计划，不授权直接实施。

### 阶段 0：确认决策与冻结行为基线

目标：明确迁移范围和验收标准，避免在重写中改变产品语义。

步骤：

1. 确认本文件第 13 节的全部待确认决策；
2. 记录当前 Python Worker 的提交 SHA、锁文件、环境变量默认值、四个工作流输入/输出 Schema 和错误码；
3. 建立脱敏 golden fixtures：正常输出、工具调用输出、结构校验失败、修复成功、Tavily 兜底、取消、超时、429、5xx；
4. 记录当前线上或预生产的 AgentRun 耗时、队列等待、Provider 429、内存、CPU、数据库连接和失败率基线；
5. 明确不比较模型自然语言逐字一致，而比较契约、领域不变量、安全性质、持久化结果和错误分类一致；
6. 冻结迁移期间禁止随意修改 Prompt、输出 Schema、工具预算和模型 Provider 配置。确需修改时必须单独评审，不能混入语言迁移。

验收：有可重复执行的基线测试清单和数据集；所有当前契约版本明确；迁移团队知道何为“行为兼容”。

### 阶段 1：建立并行 TypeScript Agent 工程骨架

目标：增加独立 Node.js/TypeScript Worker 工程，但不消费生产任务。

步骤：

1. 在不覆盖现有 Python Worker 的前提下，创建并行的 TS 工程目录和 `package.json`；
2. 通过 pnpm workspace 接入，锁定 Node.js、TypeScript、LangGraph.js、LangChain.js、BullMQ、Zod、PostgreSQL 客户端的精确版本；
3. 配置严格 TypeScript、ESLint、Vitest、构建产物和容器健康检查；
4. 实现仅返回健康/版本的独立命令入口，不连接生产队列；
5. 为所有新增代码以中文文件头注释标明职责和导出的函数/类，符合仓库约定。

验收：TS Worker 可被独立构建、测试和启动，但不写数据库、不调用模型、不消费 AgentRun。

### 阶段 2：先完成契约、Schema 与基础设施 Port

目标：让 TypeScript 有可靠的输入输出边界，而不是先写 Prompt。

步骤：

1. 从 `packages/contracts` 的 OpenAPI/JSON Schema 生成或包装 TypeScript DTO；
2. 为 `agent-run-requested.v1`、Web 内部接口、Provider SSE 事件、工具结果和每个业务产物编写 Zod 运行时校验；
3. 定义 `AgentRunRepository`、`CoreInternalClient`、`ModelGateway`、`ToolGateway`、`QueuePublisher` 等 Port；
4. 编写 PostgreSQL Repository，逐项复现 `begin_execution`、取消检查、成功/失败/重试标记、事件顺序和行锁语义；
5. 建立跨语言 AES-GCM 测试向量，证明当前 Web 加密的用户凭据可被 TS Worker 解密，且空密钥/密钥版本/认证失败的错误语义一致；
6. 不复制 Web ORM Model；Worker 只使用自己的基础设施查询和 Web 内部 API。

验收：所有入站数据都能在运行时拒绝无效结构；与现有 Web 加密格式互操作；Repository 测试覆盖重复投递和并发领取。

### 阶段 3：完成安全出网与 Tavily PoC

目标：先解决迁移中风险最高的安全边界，再接入真实模型。

步骤：

1. 实现并测试 TypeScript `ModelEgressPolicy` 与固定 IP/SNI/代理连接；
2. 实现 SSE 有界聚合器、Provider 错误分类、超时、AbortController 和最小审计；
3. 实现 OpenAI-compatible 模型 payload/响应转换，包括工具调用、结构化 JSON 和使用量；
4. 实现 Tavily Remote MCP Adapter、按用户每日配额、调用次数与工具白名单；
5. 使用模拟 DNS、模拟 Provider、模拟代理和测试 Redis 完成安全回归；
6. 在没有通过安全 PoC 前，禁止配置真实用户 BYOK 密钥给 TS Worker。

验收：第 8 节的安全性质全部可自动测试；与 Python Adapter 的稳定错误码、重试性和脱敏原则一致。

### 阶段 4：实现 TypeScript Dispatcher 与队列 Worker

目标：用 TS 替换 Celery 的投递与执行基础设施，但暂不进行线上切换。

步骤：

1. 实现 Outbox `FOR UPDATE SKIP LOCKED` 领取、锁超时恢复、发布回写和失败退避；
2. 将 `agent.run` 最小消息校验后发布到隔离的 BullMQ Redis 前缀；
3. 实现 BullMQ Worker 的优雅启动/关闭、错误处理、重试与监控；
4. 将队列 attempts/backoff 映射到现有“最多重试次数、10/20/40… 秒、最长 300 秒”的业务策略；
5. 在本地和测试环境验证“发布后崩溃、重复投递、Worker 崩溃、取消、延迟重试、队列不可用”等情形；
6. 默认并发仍为 1，先证明行为正确，再进行压测调优。

验收：TS Dispatcher/Worker 能端到端处理模拟 AgentRun，且不会因重复消息产生重复业务结果。

### 阶段 5：按风险从低到高重建业务工作流

目标：逐一用 LangGraph.js 重建现有行为，避免一次性迁移全部 Agent。

推荐顺序：

1. `assessment_generate`：输入和结果合同最明确，先验证模型、工具、题集 Schema、修复与持久化链路；
2. `posttest_generate`：复用题集子图，验证固定 CardContent 上下文；
3. `plan_generate`：验证 6–12 节点、依赖无环、序号连续等业务校验；
4. `card_content_generate`：最后迁移多字段文档、来源恢复和 `teaching_memory` 逻辑。

每个工作流的实施步骤：

1. 将当前 Python 的输入 Schema、System Prompt、工具策略、修复提示、最大调用次数、输出 Schema 列成兼容清单；
2. 用 `StateGraph` 声明 state、节点、条件边和最终输出；
3. 将每个模型/工具/持久化副作用封装为节点，避免节点直接修改全局状态；
4. 用 fake model 和 fake tool 回放 golden fixtures；
5. 在测试环境使用真实 Provider 进行少量人工评估，记录成本、延迟、Schema 成功率与工具调用数；
6. 通过契约、持久化、错误、安全和回归测试后，才允许进入下一工作流。

验收：四个 `run_type` 的成功、失败、重试、取消与幂等路径均通过测试；模型文字允许合理差异，但不得违反业务和安全合同。

### 阶段 6：压测、容量配置与 Worker Threads 验证

目标：基于实测而非语言预期设定上线并发。

步骤：

1. 分别压测 1、2、4… 个 Node Worker 副本，以及每副本不同的异步 AgentRun 并发；
2. 将 Provider 的 RPM/TPM/并发配额作为上限，增加全局、用户级或连接级限流；
3. 观察队列等待时间、AgentRun p50/p95、Provider 429、Redis 内存、PostgreSQL 连接、Web 内部 API 延迟、CPU、RSS 和事件循环延迟；
4. 对确实 CPU 密集且可纯函数化的子任务单独基准测试：主线程、Worker Threads 池、特殊 Python 处理器三种方案；
5. 仅当 Worker Threads 在真实负载下优于主线程且不突破内存预算时才启用；
6. 给每种任务定义最大输入字节、最大输出字节、执行时限、线程池大小和降级/拒绝策略。

验收：有明确的上线初始并发值和扩容规则；任何提升并发的方案都未超过 Provider、数据库、Redis、内存与成本预算。

### 阶段 7：预生产影子验证与灰度

目标：在不重复写业务结果、不意外双扣 BYOK 成本的前提下验证 TS Worker。

步骤：

1. 优先使用脱敏 fixtures、测试账户或专用测试 Provider 做影子执行；
2. 默认禁止对真实用户 BYOK 请求进行双调用影子流量，因为这会产生双倍成本、可能触及隐私数据，且模型输出本身非确定；
3. 影子流程只比较 Schema、错误分类、工具预算、持久化请求形状和安全日志，不写生产业务结果；
4. 若确需真实流量灰度，必须先取得成本、隐私、告知范围和回滚方案的明确批准；
5. 灰度以 `run_type` 或明确的执行运行时路由为单位，不能让同一个 AgentRun 同时被 Python 和 TS 两个 Worker 执行。

验收：无重复业务写入、无密钥泄露、无未解释的 Schema 回归；灰度成功率、延迟和成本达到预设标准。

### 阶段 8：切换、观察与 Python 退役

目标：安全完成单语言常态运行。

步骤：

1. 在维护窗口前将旧 Celery 队列、Outbox 待发布数量、运行中 AgentRun 和延迟重试全部观测清楚；
2. 采用经批准的路由/回滚方案，使任何具体 AgentRun 只属于一个执行运行时；
3. 发布 TS Dispatcher 和 Worker，先以低并发运行并开启完整指标与告警；
4. 恢复 AgentRun 创建，逐步扩大流量与并发；
5. 在观察期内保留 Python 镜像、锁文件和只读诊断能力，但不让其和 TS 同时消费同一 AgentRun；
6. 观察期达到约定时长、所有四类工作流稳定后，停止 Python Agent API、Dispatcher、Celery Worker，并删除 Celery 专属依赖和 Redis 键；
7. 最后更新技术栈、架构、部署、运行手册和事故处置文档，明确 Python 仅保留的特殊数据处理边界。

验收：生产不再依赖 Python 来执行通用 Agent；所有待处理任务都有可追踪归属；旧队列已安全清空或按留存策略归档。

## 11. 测试与验收矩阵

| 层级 | 必测内容 |
| --- | --- |
| 单元测试 | Zod Schema、错误分类、重试退避、工具调用上限、工作流条件边、取消检查、Worker Thread 输入输出边界 |
| 安全测试 | AES-GCM 互操作、DNS/私网/重定向阻断、固定 IP + SNI、代理、超大响应、SSE 分块、日志脱敏 |
| 契约测试 | `agent-run-requested.v1`、OpenAPI 内部接口、持久化 payload、稳定错误码、snake_case 字段 |
| 数据库集成测试 | Outbox 原子创建、`SKIP LOCKED` 并发领取、重复投递、AgentRun 行锁、事件序号、幂等业务写入 |
| 队列集成测试 | Redis 不可用、发布后崩溃、延迟重试、Worker 崩溃、优雅关闭、死信/保留策略 |
| 工作流回归测试 | 四个 `run_type` 的首轮成功、工具循环、修复、Tavily 兜底、无效输入、取消、可重试与不可重试失败 |
| E2E 测试 | 创建目标→前测→评分→路线→节点内容→后测的完整链路，且浏览器只看到最终校验结果 |
| 性能/稳定性测试 | 队列等待、p95、429、内存、事件循环延迟、PostgreSQL 连接、Redis 内存、成本和 24 小时稳定性 |

模型输出不适合作为逐字回归基线。验收应重点比较：题目数量、可选项与答案关系、路线节点数与依赖关系、内容必填字段、来源合同、持久化幂等性、错误码、工具调用次数、密钥不泄露和用户可见状态。

## 12. 发布、回滚与数据兼容性

### 12.1 不变的数据

默认情况下不迁移或重写以下数据：

- `agent.agent_runs` 与 `agent.agent_run_events` 历史；
- `public.outbox_events` 历史；
- 学习目标、题集、路线、卡片内容、作答和用户模型连接；
- 已加密的用户 API Key；
- 已有 OpenAPI 和 JSON Schema v1 契约。

TS Worker 必须能读取由现有 Web 创建的 AgentRun，并以相同内网接口提交结果。没有明确确认前，不为“TS 化”创建新的业务表、复制领域数据或修改加密密文格式。

### 12.2 队列切换的风险

Celery 与 BullMQ 是不同队列协议，不能让两类消费者盲目消费同一 Redis 结构。最安全的最小切换方式是维护窗口内清空旧队列和非终态任务，再切到新队列。

如果产品要求在迁移期间按用户、按工作流持续灰度并支持随时回滚，则仅有维护窗口不足够，通常需要给 AgentRun 增加“执行运行时/队列版本”路由字段，或设计等价的可审计路由表。这会影响数据库 Schema、Dispatcher 逻辑、历史数据和发布回滚，因此必须在实施前单独确认，不能在编码中临时决定。

回滚也分两个层次：

- **切换前回滚**：停止 TS Worker，继续使用 Python/Celery，不影响已完成的历史业务结果；
- **切换后回滚**：BullMQ 中已领取或延迟的任务不能被 Celery 直接消费。必须依赖已批准的运行时路由/重投方案，或者保持 TS Worker 处理这些既有任务直至终态，不能简单把服务切回 Python。

因此，建议上线前明确选择其一：

1. 短维护窗口、清空任务后一次性切换；或
2. 新增受审计的执行运行时路由字段，支持多周灰度与受控回滚。

第二种更灵活，但涉及数据库 Schema 变更，必须先获得用户确认。

## 13. 实施前必须确认的决策

下列事项会实质影响架构、数据库、成本、安全或上线行为。本文只提出建议，不替代确认；在相应阶段开始前必须逐项确认。

| 编号 | 待确认事项 | 推荐方向 | 影响 |
| --- | --- | --- | --- |
| D1 | 队列产品 | BullMQ + 现有独立队列 Redis，淘汰 Celery | Redis 键、重试、部署、运维和监控都会变化 |
| D2 | 迁移切换方式 | 优先一次性维护窗口；需要长期灰度则新增执行运行时路由 | 后者需要数据库 Schema 与回滚设计 |
| D3 | TypeScript Worker 最终目录和包边界 | 并行 TS 目录验证后，再确认是否接管 `apps/agent-worker` 名称 | 涉及仓库结构和 Python 归档方式 |
| D4 | 特殊 Python 白名单 | 仅保留已证明无法合理迁移的解析/OCR/科学计算能力 | 决定是否仍部署 Python 及其最小权限 |
| D5 | LangGraph Checkpoint | 首期不新增持久化；后续独立确认 PostgreSQL Checkpointer | 影响数据库、数据留存、隐私和恢复语义 |
| D6 | 安全出网实现 | 先完成固定 IP + SNI + 代理 PoC，再选 Node HTTP 底层实现 | 直接影响 SSRF 与用户 BYOK 密钥安全 |
| D7 | 初始并发与限流 | 先设 Worker=1、并发=1，以压测和 Provider 配额逐步提升 | 影响用户等待、Provider 429、成本和数据库容量 |
| D8 | Worker Threads 使用范围 | 仅纯 CPU 子任务，采用有界常驻池 | 影响内存、超时、故障隔离和代码复杂度 |
| D9 | 真实流量影子测试 | 默认禁止双调用真实 BYOK；只用测试账户/Provider | 影响成本、隐私、用户告知和数据处理范围 |

## 14. 风险清单与处理原则

| 风险 | 错误做法 | 必须采取的处理 |
| --- | --- | --- |
| 认为 TS 自动提高并发 | 迁移后不配置队列并发、Provider 限流和副本数 | 分层压测，按 Provider/数据库/成本上限配置 |
| 安全能力退化 | 直接对用户 Base URL 使用普通 `fetch` 或官方 SDK | 先完成固定 IP、SNI、代理、DNS rebinding 测试的 PoC |
| 业务重复写入 | Python/Celery 与 TS/BullMQ 同时执行同一 AgentRun | 一个 AgentRun 只路由到一个运行时；DB 状态机仍是最终幂等边界 |
| 结果逐字不一致 | 把不同模型采样结果误判为迁移失败 | 比较 Schema、不变量、持久化和安全行为，而非逐字文本 |
| 以 Worker Threads 承载 I/O Agent | 每个 AgentRun 新开线程，造成内存和调度开销 | LLM/Tavily 用异步 Worker；仅 CPU 子任务使用常驻线程池 |
| 迁移期间扩散 Python | 新功能继续写进通用 Python Agent | 设 Python 白名单和退役计划；新 Agent 编排只写 TS |
| 忽略队列协议差异 | 让 BullMQ/Celery 混用 Redis 前缀或直接切换 | Redis 前缀隔离、明确队列排空和切换/回滚策略 |
| 引入持久化图状态但未评审 | 直接创建 LangGraph checkpoint 表 | 单独确认 Schema、留存、敏感字段、恢复和迁移 |

## 15. 完成定义

只有同时满足以下条件，才可宣告“Agent 侧已全栈统一为 TypeScript”：

1. Web、Dispatcher、通用 Agent Worker、模型网关、工具网关和四个业务工作流均由 TS/Node.js 运行；
2. 四个 `run_type` 全部以 LangGraph.js 图实现，并通过 Zod 与契约测试；
3. Celery、Python 通用 Agent Worker、Python Agent API 的生产职责已移除；
4. Python 若仍存在，仅是经批准的特殊数据处理服务，具备独立、最小化的任务契约和权限；
5. AgentRun/Outbox/业务写入/模型密钥/安全出网/取消/重试/审计的验收项全部通过；
6. 完成压测并给出经 Provider 配额约束的并发配置；
7. 完成观察期，无未解释的重复执行、数据不一致、密钥暴露、安全绕过或显著成本回归；
8. 代码、Compose、环境变量、CI、运行手册、架构文档和事故处置文档均反映 TS 单语言常态架构。

