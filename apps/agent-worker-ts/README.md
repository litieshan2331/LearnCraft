# LearnCraft Agent Worker（TypeScript）

本目录是 Agent 侧 TypeScript 实现的**并行工程**，用于逐步替换 `apps/agent-worker` 的 Python 实现。
迁移方案、阶段划分与验收标准见 [docs/09-全栈TypeScript迁移方案.md](../../docs/09-全栈TypeScript迁移方案.md)。

## 目录说明约定

每个目录下都有一份 `README.md`，说明该目录的职责与其下每个文件的作用（对应 Python 包 `__init__.py`
的说明功能）；新增目录时必须一并添加。

## 当前范围

| 文件 | 职责 |
| --- | --- |
| `src/infrastructure/llm/public-address.ts` | 公网地址判定（自建拒绝表，等价于 Python 的 `ipaddress.is_global`），显式解包 IPv4-mapped IPv6 与 NAT64 |
| `src/infrastructure/llm/egress-policy.ts` | Base URL 策略：仅 https/443、禁止 userinfo 与相对路径段、禁止 IP 字面量与本地域名、DNS 全结果校验并钉死首个地址 |
| `src/infrastructure/llm/safe-egress-client.ts` | 受控出网客户端：固定 IP 连接 + 原域名 SNI/证书校验 + 显式 Host 头、禁止重定向、按解压后字节限制响应体、SSE 结构校验、出网前审计 fail-closed |
| `src/infrastructure/llm/credential-decryptor.ts` | 凭据信封解密，错误码与 Python 的 `ModelCredentialDecryptor` 一致；加密实现来自共享包 |
| `src/infrastructure/database/agent-run-repository.ts` | AgentRun 生命周期 Repository：`FOR UPDATE` 行锁、终态短路幂等、事件序号、retry_count 单调、错误字段截断 |
| `src/infrastructure/llm/model-gateway.ts` | OpenAI-compatible 网关：载荷构造、SSE 聚合（含工具调用分片合并）、错误分类与退避重试 |
| `src/acl/core-internal-client.ts` | Web 内部接口防腐层：5 个端点、统一超时与鉴权、错误分类、响应契约校验 |
| `src/schemas/*.ts` | zod 运行时契约：内部接口响应与题集业务合同 |
| `src/application/services/tool-aware-generator.ts` | ReAct 会话循环：一次运行一个会话，工具成功/失败都回传同一会话，校验失败把字段路径回灌自纠，轮数与工具调用数双上限；可选进度上报 |
| `src/application/services/agent-progress.ts` | 实时进度事件契约（步骤级 + 工具级，**不含模型原文**），配合 `infrastructure/redis/agent-progress-publisher.ts` 发布到 `learncraft:agent-progress:{run_id}` 临时频道，不落库 |
| `src/workflows/` | 四个 P0 业务工作流（每个工作流一个子目录：`assessment-generate/`、`posttest-generate/`、`plan-generate/`、`card-content-generate/`，目录内按 `schema/`、`prompts/`、`recovery/` 职责分文件夹；`shared/` 放跨工作流复用模块）。**每个工作流是单一 persona 的 ReAct 会话**；后续替换为 LangGraph.js 图为可选项 |
| `src/application/commands/execute-agent-run.ts` | 命令层：领取 → 取消检查 → 路由 → 执行 → 回写（含真实 token 用量）；错误归类与重试策略 |
| `src/application/services/agent-workflow-registry.ts` | `run_type` → 工作流注册表 |
| `src/infrastructure/queue/outbox-dispatcher.ts` | Outbox 投递器：`FOR UPDATE OF o SKIP LOCKED` + `run_type` 路由 + 优雅关闭 |
| `src/infrastructure/queue/bullmq-agent-queue.ts` | BullMQ 装配：jobId 去重、attempts、自定义退避、锁时长、键前缀隔离 |
| `src/interfaces/queue/agent-run-processor.ts` | BullMQ 消费适配器：重投与 `UnrecoverableError` 语义 |
| `src/infrastructure/database/model-egress-audit-repository.ts` | 出网审计写入 `public.model_connection_egress_audits`：同事务清理过期行 + 插入，只含七个安全字段 |
| `src/main/dispatcher.ts`、`src/main/worker.ts` | 进程入口与优雅关闭 |

共享包 `packages/security-primitives` 提供 Web 与 Worker 共用的 AES-256-GCM 实现；Web 侧
`apps/web/src/lib/security/credential-crypto.ts` 已改为转出该包，对外行为不变。

## 尚未实现

- 字段级 HTTP/SSE 超时总预算的压测（见 `docs/09` 待办清单第 3 项）。
- 本工程的 ESLint，以及 `packages/contracts/ts` 的 DTO 生成。
- 四个工作流的 LangGraph.js 图化（可选演进：Python 侧同样未使用图）。

已知差异（做等价性复核时不要当成缺陷）：

- **token 用量写真实值**（2026-09-17 用户确认）：Python 的 `mark_succeeded` 恒定写 0，本实现要求调用方
  把工作流返回的 `usage` 写入 `agent_runs` 的 token 列；`outputSummary` 仍保持 Python 的 6 键。

### ReAct 会话改造（2026-09-18 用户确认）

四个工作流由「按阶段重建消息列表 + 追加上一轮原文与修复指令」改为**单一 persona 的 ReAct 会话**：

- 一次运行只有一个会话与一个人格；工具成功与失败都以 tool 消息回传同一会话，校验失败以 user 观察消息
  回灌字段路径，模型在同一上下文内自纠；不再有阶段切换与断网降级人格；
- 轮数上限按工作流注入（`AGENT_REACT_MAX_TURNS_*`，默认 5 / 5 / 10 / 5），语义是**一次运行内允许的
  模型调用次数（含只产生工具调用的轮次）**，因此它同时是成本上限；
- 最终 JSON 不再用 `response_format` 约束，改为提示词约定 + `extractJsonText` 剥离围栏后严格校验；
- **产品边界变更（后测）**：`posttest_generate` 全程开放 `tavily_search`，节点内容与 `teaching_memory`
  仍是主要出题依据，不再禁止外部核对；
- **元数据键不变、取值按语义映射**：`recovery_stage`（用过工具 → `tavily_recovery`；未用工具首答即通过
  → `initial`；同一会话内自纠后通过 → `repair`）；`generation_path`（未用工具 → `model_knowledge`；
  用工具首答即通过 → `model_with_tavily`；用工具且自纠 → `tavily_recovery`）；`repair_attempts` =
  首次通过前的校验失败次数；`fallback_used` = 是否发生过自纠；Web 侧无需改动；
- **模型网关错误直接上抛**：不再由工作流吞掉后进入下一阶段，改由 BullMQ 任务级重试处理（网关自身仍按
  `MODEL_GATEWAY_REQUEST_MAX_RETRIES` 做退避重试）。

除此之外，提示词核心文案、校验规则、回写载荷字段、输出摘要键与错误码保持与 Python 一致。

## 命令

```powershell
pnpm --filter @learncraft/agent-worker-ts typecheck
pnpm --filter @learncraft/agent-worker-ts test
```

## 进程与环境变量

两个进程入口均为独立 Node 进程，不暴露公网：

```powershell
node --experimental-strip-types src/main/dispatcher.ts   # 或构建后运行
node --experimental-strip-types src/main/worker.ts
```

| 环境变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串（Dispatcher 与 Worker） |
| `AGENT_QUEUE_REDIS_URL` | **独立于认证 Redis** 的队列 Redis；键前缀默认 `learncraft:agent-queue:` |
| `AGENT_QUEUE_PREFIX` / `AGENT_QUEUE_NAME` | 队列键前缀与队列名（默认 `agent.run`） |
| `AGENT_WORKER_CONCURRENCY` | 单进程异步并发（默认 1） |
| `AGENT_JOB_LOCK_DURATION_MS` | 必须大于任务硬超时（默认 660000） |
| `AGENT_JOB_MAX_ATTEMPTS` / `_BACKOFF_MS` / `_BACKOFF_MAX_MS` | 重试次数与退避（默认 3 / 10000 / 300000） |
| `OUTBOX_DISPATCHER_ID` | 多实例必须各自唯一 |
| `OUTBOX_BATCH_SIZE` / `_POLL_INTERVAL_SECONDS` / `_LOCK_TIMEOUT_SECONDS` / `_MAX_ATTEMPTS` | 领取参数（默认 20 / 1 / 900 / 10） |
| `CORE_INTERNAL_BASE_URL` / `INTERNAL_SERVICE_SECRET` | Web 内部接口地址与服务密钥 |
| `CREDENTIAL_ENCRYPTION_KEY` / `_VERSION` | 凭据解密主密钥与版本 |
| `MODEL_EGRESS_*` | 受控出网参数；生产启用出网时必须配置代理 |
| `AGENT_TOOL_MAX_CALLS` | 单次运行可见的联网工具调用上限（默认 6） |
| `AGENT_REACT_MAX_TURNS_ASSESSMENT` / `_POSTTEST` / `_PLAN` / `_CARD_CONTENT` | 四个工作流各自的 ReAct 轮数上限（默认 5 / 5 / 10 / 5） |

Python 运行时已下线（编排中不再有任何 Python 服务），因此 Dispatcher 领取**全部** `agent.run.requested` 事件，
不再按 `run_type` 过滤；未注册工作流的 `run_type` 会在命令层以 `AGENT_RUN_WORKFLOW_NOT_REGISTERED` 明确失败，
不会静默滞留。

### 本机 Compose

`infra/compose.yaml` 已包含两个 TypeScript 进程（镜像 `infra/docker/agent-worker-ts.dev.Dockerfile`）：

| 服务 | 作用 |
| --- | --- |
| `agent-worker-ts` | 消费 BullMQ 队列执行 AgentRun；加入 `private + egress` 双网 |
| `agent-dispatcher-ts` | 领取全部 Outbox 事件并投递 BullMQ；只在内网 |

`apps/agent-worker` 的 Python 实现（含当时为灰度新增的 `AGENT_RUNTIME_ROUTES` 过滤）已不再被任何编排启动，
仅作为迁移参照保留，因此仓库里不会再有第二个运行时与它竞争同一条 Outbox 事件。

本地不启动 Compose 时，可直接运行两个入口（需要先 `pnpm build`）：

```powershell
node dist/worker.js
node dist/dispatcher.js
```

### 真实数据库只读冒烟（默认跳过，只执行 SELECT）

```powershell
$env:AGENT_TS_TEST_DATABASE_URL = '<postgres 连接串>'
$env:CREDENTIAL_ENCRYPTION_KEY = '<Base64 的 32 字节主密钥>'
$env:CREDENTIAL_ENCRYPTION_KEY_VERSION = '<密钥版本>'
pnpm --filter @learncraft/agent-worker-ts exec vitest run tests/integration/live-readonly.test.ts
```

该用例会核对 `agent` schema 的列是否覆盖 Repository 使用的字段，并解密一条真实模型连接凭据
（只输出长度与前缀，不输出明文），不会写入任何数据。

### 真实端到端冒烟（会产生真实费用并写入真实数据）

`tests/integration/live-e2e.test.ts` 执行完整链路：写入夹具（goal + agent_run）
→ `beginExecution` 领取并加行锁 → 解密真实凭据 → 受控出网调用真实 Provider（SSE）
→ `markSucceeded` 回写 → 校验状态与事件序列 → 验证重复投递幂等。

必须同时设置三项才会运行，否则整个文件跳过：

```powershell
$env:AGENT_TS_LIVE_E2E = '1'          # 显式确认：允许真实模型调用与真实写入
$env:AGENT_TS_TEST_DATABASE_URL = '<postgres 连接串>'
$env:CREDENTIAL_ENCRYPTION_KEY = '<Base64 的 32 字节主密钥>'
$env:CREDENTIAL_ENCRYPTION_KEY_VERSION = '<密钥版本>'
pnpm --filter @learncraft/agent-worker-ts exec vitest run tests/integration/live-e2e.test.ts
```

用例**不会**自行删除夹具（便于人工核对运行记录），执行结束会打印三条清理 SQL。
该用例只应在本机开发库运行，不得指向生产库。

### 队列链路真实验证（真实 Redis）

`tests/integration/live-queue.test.ts` 包含两个用例：

1. 在真实数据库上校验领取 SQL：`run_type` 路由过滤生效，且 `FOR UPDATE OF o` 不会锁住 `agent.agent_runs`
   （用第二个事务对同一行做 `FOR UPDATE NOWAIT` 证明；若写成裸 `FOR UPDATE` 会得到 55P03）。
2. 发布到 BullMQ 并由 Worker 消费，完成一次真实 AgentRun（需要 `AGENT_TS_LIVE_QUEUE_MODEL=1`）。

用例使用形如 `learncraft:agent-queue:itest:<pid>:` 的独立前缀并在结束时 `obliterate`，不污染生产键。

`tests/fixtures/test-only-*.pem` 是仅用于回环 TLS 测试的自签证书，不是任何环境的真实凭据。
