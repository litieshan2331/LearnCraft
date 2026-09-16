# LearnCraft Agent 侧 TypeScript 迁移方案

> 文档状态：迁移方向已确认，待实施
> 更新日期：2026-09-16
> 文件名保留 `09-全栈TypeScript迁移方案.md` 以保持引用稳定；本文内容已收敛为 **Agent 侧**迁移方案。
> 本版直接改写 2026-09-13 版，已确认的决策见第 1 节，仍待确认的事项集中见第 15 节。
> **本文不修改数据库 Schema、不修改现有 Python 代码、不修改 Compose 与生产服务。** 实施按第 9 节分阶段进行，每阶段通过验收后才进入下一阶段。

## 1. 决策摘要

| 编号 | 事项 | 结论 | 状态 |
| --- | --- | --- | --- |
| D1 | 迁移范围 | Agent 侧**全部**迁移到 TypeScript/Node.js，**不保留任何 Python 运行时**（原“特殊数据处理保留 Python”的白名单为空，不再有 `data-processor` 服务） | 已确认 |
| D2 | 队列产品 | 以 **BullMQ + 独立队列 Redis** 替代 Celery；Redis 键前缀与 Celery 完全隔离 | 已确认 |
| D3 | 切换方式 | **按 `run_type` 灰度路由**：Dispatcher 侧 join `agent.agent_runs` 决定投递到 Celery 还是 BullMQ。**零 Schema 变更、不停服、回滚只需改映射并重启 Dispatcher** | 已确认 |
| D4 | 并发与限流 | 设计目标**峰值 20 并发 AgentRun**；所有并发、限流、超时、重试参数必须参数化，压测后再定值 | 已确认 |
| D5 | 优雅关闭 | Dispatcher 与 Worker 必须补上 `SIGTERM`/`SIGINT` 优雅关闭与在飞任务回收（现状完全没有，属**行为改进**，已确认纳入本次范围） | 已确认 |
| D6 | 契约文档 | 顺手修正 `packages/contracts/openapi/core.yaml` 的三处实现漂移（见第 13 节） | 已确认 |
| D7 | 安全出网实现 | 先完成 PoC（`node:https`/`node:tls` 与 undici `Agent` 两条路线二选一），**PoC 通过前不得给 TS Worker 配置真实用户 BYOK 密钥** | 待 PoC 结果确认 |
| D8 | LangGraph Checkpoint | 首期**不引入**持久化 Checkpointer；后续若引入需单独确认表结构、留存与隐私策略 | 待确认 |
| D9 | Worker Threads | 仅承接纯 CPU、可序列化的子任务，使用有界常驻池，默认**不启用** | 待确认（默认保守） |
| D10 | 真实流量影子测试 | 默认**禁止**对真实用户 BYOK 做双调用影子流量（双倍成本 + 隐私风险）；只用测试账户/测试 Provider | 已确认（默认禁止） |

## 2. 决策依据：真实收益与两个必须纠正的假设

迁移方向已定，但实施者必须知道真实理由，否则会在后续设计里做出错误取舍。

**本次迁移的真实收益：**

1. **双栈合一**：目前 Web 是 TypeScript、Agent 是 Python，需要维护两套运行时、两套依赖锁、两套 CI 与 OpenAPI/JSON Schema ↔ Pydantic/Zod 的双向手工对齐（`packages/contracts` 目前只有 README，没有生成产物）。
2. **每并发槽位的边际内存成本更低**：Python 当前是 Celery prefork 池，“一个并发 = 一个进程”（含 SQLAlchemy、httpx、pydantic、cryptography 等已导入模块）；Node 中“一个并发 = 一个 async 任务”。达到同样的 20 并发，Node 的内存增量显著更小，这对峰值并发与容器密度是实质差别。
3. **契约单点化**：内部 API 的 Zod schema、Drizzle 表定义、`output_summary_json` 结构都可以在 TS 内共享类型，减少漂移。

**必须纠正的假设一：Python 在 I/O 密集场景不如 TypeScript。**
不成立。当前系统同时只能执行 1 个 AgentRun，原因不是语言，而是部署配置与执行壳：

| 事实 | 位置 |
| --- | --- |
| 并发默认 1，Linux 容器内 Celery 默认 prefork 池，即“并发数 = 子进程数” | `apps/agent-worker/src/learncraft_agent/core/config.py:261-265`、`core/celery_app.py:50-51` |
| Compose 注入 `CELERY_WORKER_CONCURRENCY:-1`，且**没有任何 `replicas` 或资源限制** | `infra/compose.yaml:206,258`、`infra/compose.production.yaml:76,108` |
| `infra/.env` 实际值 1，`worker_prefetch_multiplier=1` | `infra/.env:31`、`core/celery_app.py:51` |
| 执行壳用模块级全局 `asyncio.Runner` 复用事件循环，隐含“每进程独占一个事件循环”的假设；直接改用线程池并发会让多个任务争用同一个 Runner | `interfaces/celery/tasks.py:31-38` |

也就是说：把并发调到 8、或把执行壳改成“单事件循环 + 信号量并发”，Python 同样可以承载几十个并发 AgentRun。**迁移到 TS 并不会自动带来更高吞吐**，第 3 节的并发设计必须照做。

**必须纠正的假设二：TypeScript 更擅长 CPU 密集任务。**
Node 与 CPython 的差别是真实的（V8 的纯计算、JSON 处理、字符串处理通常快于 CPython），但 **Node 主线程同样是单线程**：CPU 密集任务在两种语言下都必须移出主执行体（Python 多进程 / Node `worker_threads`），否则阻塞的都是同一个事件循环。因此**不得因为“TS 更快”而省略限流、背压与 CPU 隔离设计**。当前 Agent 主链路（LLM SSE、Tavily、内部 HTTP）是 I/O 密集型，CPU 隔离只在实测证明必要时启用（见 D9、第 8.6 节）。

## 3. 容量基线与并发设计（峰值 20）

### 3.1 容量模型

已确认的 SLO：路线生成 p95 ≤ 60 秒、卡片内容 p95 ≤ 30 秒、TTFV 中位数 ≤ 5 分钟（`docs/03-MVP-PRD.md:337-338,366`）。据此按 Little 定律估算：

| 目标吞吐 | 平均并发 | 峰值并发（×2.5） | Python prefork 内存（按 250MB/槽估算） | Node 单进程 |
| --- | --- | --- | --- | --- |
| 60 目标/小时 | ≈2.5 | 6–8 | 1.5–2 GB | 约 150 MB |
| 300 目标/小时 | ≈12.5 | 30–40 | 7.5–10 GB | 约 250 MB |

本次设计目标取**峰值 20 并发**，位于两档之间。`250MB/槽` 与 `150–250MB/进程` 均为待实测的经验值，**必须**在阶段 0 用 `docker stats` 与真实 AgentRun 实测替换（见 3.5）。

### 3.2 目标拓扑

```text
Browser
  │ HTTPS
  ▼
Next.js Web / Core API（TypeScript，保持不变）
  │  同一事务：INSERT agent.agent_runs + run.queued 事件 + public.outbox_events
  ▼
public.outbox_events
  ▼
Dispatcher（灰度期：Python 与 TS 各一个，按 run_type 过滤领取）
  ├─ 属于 Python 的 run_type → Celery Redis → Python Celery Worker（逐步减少至 0）
  └─ 属于 TS 的 run_type     → BullMQ Redis → Node.js Agent Worker（LangGraph.js）
                                                        ├─ 用户选择的 OpenAI-compatible Provider（受控出网）
                                                        ├─ Tavily 远程 MCP
                                                        └─ Web 内部 API（5 个端点）
```

- TS Agent Worker **不暴露公网**，只保留一个最小 `/health`（字段与现状一致：`status`/`service`/`version`/`git_sha`），供 Compose 健康检查使用；现状的 `/health` 不探测数据库、Redis 与 Broker，**不作为 readiness 依据**，迁移后保持等价，不得擅自升级为 readiness（升级属新增能力，另行确认）。
- 只有 Worker 容器加入 `egress` 网络，并独占 `CREDENTIAL_ENCRYPTION_KEY`、`TAVILY_API_KEY` 等敏感变量；Dispatcher 只需要 `DATABASE_URL`、队列连接与 `INTERNAL_SERVICE_SECRET`。

### 3.3 参数化配置清单（全部由环境变量注入，禁止硬编码）

| 配置项（建议命名） | 初值 | 对应现状 | 说明 |
| --- | --- | --- | --- |
| `AGENT_WORKER_CONCURRENCY` | 10 | `CELERY_WORKER_CONCURRENCY=1` | 单 Node 进程内的异步并发 AgentRun 数 |
| `AGENT_WORKER_REPLICAS` | 2 | 无（当前固定 1 容器） | 通过 Compose `replicas` 配置 |
| `AGENT_QUEUE_LIMITER_MAX` / `_DURATION_MS` | 待压测定 | 无 | BullMQ `limiter`，Provider 侧限流 |
| `AGENT_JOB_LOCK_DURATION_MS` | 660000 | `CELERY_VISIBILITY_TIMEOUT_SECONDS=660` | 必须 **大于**硬超时 |
| `AGENT_JOB_SOFT_TIMEOUT_MS` | 480000 | `CELERY_TASK_SOFT_TIME_LIMIT_SECONDS=480` | 协作式取消 + `AbortController` |
| `AGENT_JOB_HARD_TIMEOUT_MS` | 600000 | `CELERY_TASK_TIME_LIMIT_SECONDS=600` | 硬超时后中止外部请求并标记失败 |
| `AGENT_JOB_MAX_ATTEMPTS` | 3 | `CELERY_TASK_MAX_RETRIES=3` | 业务重试次数 |
| `AGENT_JOB_BACKOFF_MS` / `_MAX_MS` | 10000 / 300000 | `CELERY_RETRY_BACKOFF_SECONDS=10` / `_MAX=300` | 退避必须封顶 300 秒 |
| `AGENT_SHUTDOWN_GRACE_MS` | 30000 | Dispatcher `stop_grace_period: 30s` | 优雅关闭窗口 |
| `AGENT_DB_POOL_MAX` | 12 | `NullPool`（每会话新建连接） | TS 侧改用有界连接池，见 5.4 |
| `OUTBOX_*` | 保持现值 | `OUTBOX_POLL_INTERVAL_SECONDS=1`、`BATCH_SIZE=20`、`LOCK_TIMEOUT_SECONDS=900`、`MAX_ATTEMPTS=10` | 领取语义不得改变 |
| `AGENT_TOOL_MAX_CALLS` | 6 | 同现状（配置层上限亦为 6） | 工具调用硬上限 |
| `TAVILY_DAILY_TOOL_CALL_LIMIT` | 20 | 同现状 | 每用户每日可见工具调用次数 |
| `MODEL_EGRESS_*` | 保持现值 | connect 10s / read 120s / 8MiB / 审计 30 天 | 生产必须配置 `MODEL_EGRESS_PROXY_URL` |

初始值取“10 并发 × 2 副本 = 20 峰值”，全部可调；**在任何压测数据出来之前，不得对外承诺吞吐数字**。

### 3.4 三条并发不变式

1. **超时分层不变**：软超时 480s < 硬超时 600s < 队列锁 660s。BullMQ 的 `lockDuration` 取代 Celery 的 `visibility_timeout`，必须保持在硬超时之上。
2. **提高本地并发必须同时提高 Provider 限流**，否则只是把等待从队列搬到 HTTP 429，并放大成本与失败率。本项目为 BYOK，Provider 配额按用户各自的 Key 生效，因此需要“全局 + 每用户/每连接”两级限流。
3. **`agent.agent_runs` 的行锁与状态机是唯一幂等边界**：并发提高会提高重复投递概率，`begin_execution` 的 `SELECT ... FOR UPDATE`、`trace_id` 比对、终态短路必须在同一事务内逐项等价复现，事件序号 `MAX(sequence_no)+1` 不得脱离行锁执行。

### 3.5 压测方法（阶段 0 与阶段 6）

- 阶段 0：记录当前 Python 侧基线 —— 单次各 run_type 的耗时分布、并发 1/2/4 时的队列等待、prefork 子进程实际内存、Provider 429 比例、PostgreSQL 连接数。
- 阶段 6：对 TS Worker 压测 1/2/4 副本 × 每副本不同 `concurrency`，观察队列等待、AgentRun p50/p95、429、Redis 内存、PG 连接、事件循环延迟（`perf_hooks.monitorEventLoopDelay`）、RSS。
- 只有 `worker_threads` 在真实负载下优于主线程且不突破内存预算时才启用，并定义最大输入/输出字节、执行时限、池大小与拒绝策略。

## 4. 现状盘点

### 4.1 代码规模与目标映射

`apps/agent-worker/src` 共 64 个文件、约 5183 行（不含空行）；`tests` 16 个文件、约 1157 行。

| 现状模块 | 规模 | TypeScript 目标 | 风险 |
| --- | --- | --- | --- |
| `infrastructure/llm/`（`safe_egress_client` ≈597、`openai_compatible_model_gateway` ≈513、`egress_policy` ≈190、`credential_decryptor` ≈111） | 1721 行 | `infrastructure/llm/*`（`node:https`/`tls` 或 undici + Zod） | **极高** |
| `infrastructure/mcp/tavily_remote_mcp.py` | ≈329 行 | `infrastructure/mcp/*`（`@modelcontextprotocol/sdk`） | 高 |
| `workflows/plan_generate.py` | ≈691 行 | LangGraph.js 图 + 恢复归一化器 | 高 |
| `workflows/card_content_generate.py` | ≈464 行 | 同上 | 中高 |
| `workflows/question_set_generation.py`（前后测共用）+ `assessment_generate.py` + `posttest_generate.py` | ≈246+130+187 | 共享题集子图 + 两个图 | 中 |
| `infrastructure/queue/dispatcher.py` | ≈251 行 | `dispatcher/*` + BullMQ producer | 中 |
| `acl/web_core_internal_client.py` | ≈300 行 | `acl/*`（以 Web 侧 Zod schema 为规格） | 低 |
| `infrastructure/persistence/*`、`interfaces/celery/tasks.py` | ≈350 行 | `infrastructure/database/*` + BullMQ consumer | 中 |
| `application/ports`、`application/services`、`dto`、`interfaces/http` | ≈450 行 | Zod schema + Port 接口 + 最小 health | 低 |

### 4.2 四个工作流的真实复杂度（不可简化）

| `run_type` | 现有步骤与次数上限 |
| --- | --- |
| `assessment_generate` | 三阶段：initial → repair（**不带工具**）→ tavily_recovery（带工具）；题量 10–20，必须与 `question_count` 严格相等 |
| `posttest_generate` | 三阶段，且 **repair 与 final 两阶段都开放 Tavily**；题目 5–10；失败码改写为 `POSTTEST_OUTPUT_INVALID`，另加 `POSTTEST_QUESTION_COUNT_INVALID` |
| `plan_generate` | 首轮 + 最多 2 次无工具修复校验；失败后强制 Tavily 重建；工具失败则走“无资料重建”；恢复路径再做最多 2 次校验 + 1 次修复；附带一整套字段归一化器 |
| `card_content_generate` | 首轮 + 1 次无工具修复；捕获**任意** `ModelGatewayError` 后进入 Tavily 重建；工具失败走无资料重建；`pitfalls_debug` 键集合必须严格等于 {title, cause, fix} |

**这四次数的组合是行为合同，不是实现细节**：迁移时必须逐条保留，不得因为“上了 LangGraph 就顺手简化”。

### 4.3 部署现状

- 同一个 Dockerfile（`infra/docker/agent-worker.Dockerfile`，python 3.11.15-slim + uv）构建三个进程：`agent-api`（FastAPI，仅 `/health`）、`agent-dispatcher`、`agent-celery-worker`。
- 只有 `agent-celery-worker` 加入 `private + egress` 双网；`egress` 只是一张 Docker 网络，**不是防火墙**（`infra/README.md:119`）。
- 无 `replicas`、无任何 CPU/内存限制；Dispatcher 与 Worker 都没有 healthcheck；Dispatcher `stop_grace_period: 30s`，Worker `11m`。
- 生产 `MODEL_EGRESS_ENVIRONMENT=production` 且启用出网时必须有 `MODEL_EGRESS_PROXY_URL`（配置层硬校验，`core/config.py:191-211`）。

### 4.4 工程缺口（被低估的工作量）

| 缺口 | 现状 | 迁移必须补齐 |
| --- | --- | --- |
| CI | 无 `.github/`、无 `.gitlab-ci.yml` | TS Worker 的 lint/typecheck/test/build 流水线 + 契约破坏性变更检查 |
| 共享 tsconfig | 只有 `apps/web/tsconfig.json` | TS Worker 自己的严格 tsconfig |
| 测试配置 | 没有 `vitest.config.*`，依赖默认发现规则 | Worker 侧显式配置 |
| 包导出 | `@learncraft/web` 与 `@learncraft/contracts` 都是 `private` 且**没有 `exports` 字段** | 跨包复用前必须补包导出，或新建独立包 |
| 契约产物 | `packages/contracts/{ts,python}` 只有 README | TS 侧 DTO 的生成或包装方案 |
| 跨语言加密向量 | **不存在** | 见 8.4 |

## 5. 必须等价复现的契约

### 5.1 九条硬约束

1. **事务边界**：创建 `agent.agent_runs` + 首条 `run.queued`（`sequence_no=1`）+ `public.outbox_events`（`agent.run.requested`，`event_version=1`，payload `{agent_run_id, trace_id, task_version:1}`）必须同一事务。
2. **状态机归属**：Web 只写 `queued` 与 `cancelled`；`running/succeeded/failed/expired` 与重试计数由 Worker 写。终态集合 `{succeeded, failed, cancelled, expired}`，进入终态后所有 `mark_*` 必须直接返回（幂等短路）。
3. **`begin_execution` 语义**：`SELECT ... FOR UPDATE`（无 `SKIP LOCKED`、无 `NOWAIT`）；`trace_id` 不一致即失败；`queued → running` 追加 `run.started`；`running` 追加 `run.resumed`；`retry_count` 单调不减。
4. **事件序号**：`MAX(sequence_no)+1` 必须在上面的行锁事务内执行；DB 侧唯一约束 `uq_agent_run_events_sequence(agent_run_id, sequence_no)` 是最后防线。
5. **`output_summary_json` 键固定**：`{assessment_id, status, question_count, tool_call_count, recovery_stage, model_id}`、`{assessment_id, question_count, tool_call_count, recovery_stage, model_id}`、`{learning_plan_id, node_count, tool_call_count, repair_attempts, generation_path, model_id}`、`{card_content_id, plan_node_id, tool_call_count, model_id}`；公开 API 直接读 `assessment_id`/`question_count`/`learning_plan_id`/`node_count`，多一个少一个键都会影响浏览器可见结果。
6. **工具预算语义**：达到 `AGENT_TOOL_MAX_CALLS` **不报错**，而是回填 `TOOL_CALL_LIMIT_REACHED` 工具消息并移除 tools；Tavily 配额耗尽或配额 Redis 不可用时**不得绕过限制访问网络**，只把结构化错误回填模型。
7. **截断而非拒绝**：现状 `Field(max_length=...)` 多为元数据，真正的截断由手工切片完成（`url[:2048]`、`content[:2000]`、`raw_content[:1500]`）。TS 侧若只写 Zod 的 `max()` 会**拒绝**请求而不是截断，属行为变更。
8. **错误码与用户文案**：`AGENT_RUN_RETRY_EXHAUSTED`（“任务重试次数已用尽，请稍后重新发起。”）、`AGENT_RUN_WORKFLOW_NOT_REGISTERED`（“该任务类型暂未开放执行。”）、`AGENT_RUN_UNEXPECTED_ERROR`、`POSTTEST_OUTPUT_INVALID`、`POSTTEST_QUESTION_COUNT_INVALID`、`CARD_CONTENT_OUTPUT_INVALID` 等必须逐字保留语义。
9. **凭据不出行**：队列消息、日志、AgentRun、Checkpoint、浏览器均不得出现 API Key 明文；Celery/BullMQ 载荷只含 `agent_run_id`、`trace_id`、版本。

### 5.2 五个内部端点（实现为唯一事实源）

| 方法 | 路径（前缀 `CORE_INTERNAL_BASE_URL`，默认 `http://web:3000/internal/v1`） | 超时 | 备注 |
| --- | --- | --- | --- |
| GET | `/agent-runs/{id}/default-model-connection` | 10s | 返回 `credential{ciphertext_base64, iv_base64, auth_tag_base64, encryption_key_version}` |
| GET | `/agent-runs/{id}/card-content-context` | 15s | 仅 `posttest_generate` + `target_type='plan_node'` |
| POST | `/agent-runs/{id}/assessment-result` | 15s | 前测与后测共用；幂等键 `generation_metadata.agent_run_id` |
| POST | `/agent-runs/{id}/plan-result` | 20s | 幂等键同上；会把同目标旧 active 计划置 `superseded` |
| POST | `/agent-runs/{id}/card-content-result` | 20s | 已有 ready 内容则直接返回既有 id |

- 鉴权头：`x-learncraft-internal-secret`（实现为准），Web 侧用长度比较 + `timingSafeEqual`。
- 全部请求/响应字段为 **snake_case**，Python 侧校验模型一律 `extra="forbid"`；TS 侧多输出一个键就会把 Worker 打成 `CORE_INTERNAL_RESPONSE_INVALID`，因此 Zod 必须用 strict。
- 错误分类：网络异常与 5xx 可重试；4xx、鉴权失败、契约不符不可重试。错误响应体是 `{"error":"CODE"}`（可带 `field_errors` 数组）。
- **内部端点不校验 AgentRun 是否处于 running，也不写 `agent_runs`**：运行状态完全由 Worker 负责，迁移后必须保持这一分工。

### 5.3 队列与 Outbox 契约

- `public.outbox_events.status`：`pending / processing / published / failed / dead`（DB CHECK 固定）。
- 投递退避 `min(300, 10 × 2^(attempt-1))` 秒，尝试上限 10 次后转 `dead`；契约错误（版本非 1、`aggregate_id ≠ agent_run_id`、载荷不合法）直接转 `dead`。
- 回写必须带锁拥有者条件：`WHERE id = :id AND status='processing' AND locked_by = :dispatcher_id`。
- 多 Dispatcher 并存时必须配置**互不相同**的 `OUTBOX_DISPATCHER_ID`，否则会互相覆盖状态。

### 5.4 数据库访问边界

- Worker 只映射 `agent.agent_runs` 与 `agent.agent_run_events`；`public.outbox_events` 只用参数化 SQL。
- **绝不直写 Web 核心业务表**：学习计划、题集、卡片内容一律经 Web 内部 API 幂等写入。
- 现状 Python 使用 `NullPool`（每会话新建物理连接）。TS 侧改用有界连接池是**行为改进**：必须同时确认最大连接数、锁持有时间与 PG `max_connections` 的关系，并保证 `FOR UPDATE` 始终在同一连接的事务内。
- 现状存在**混合时钟**（`mark_*` 用进程时钟，Dispatcher 与 Web 用数据库 `now()`）。迁移时必须明确统一策略，否则 `available_at <= now()` 与 `finished_at` 会互相矛盾。

## 6. 目标架构与仓库改动

```text
apps/
├─ web/                          # 不改：页面、鉴权、领域服务、业务事务、5 个内部端点
├─ agent-worker-ts/              # 新增：并行存在，不覆盖现有 Python 工程
│  └─ src/
│     ├─ bootstrap/              # 配置、依赖装配、优雅关闭
│     ├─ dispatcher/             # Outbox 领取 + 按 run_type 路由 + BullMQ 发布
│     ├─ queue/                  # BullMQ producer/consumer、重试与超时映射
│     ├─ application/
│     │  ├─ commands/            # ExecuteAgentRun：领取、取消检查、错误归类、终态
│     │  ├─ ports/               # ModelGateway、ToolGateway、CoreInternalClient、审计、时钟
│     │  └─ services/            # 工具循环、预算、生命周期
│     ├─ workflows/              # 四个 LangGraph.js 图 + 共享题集子图
│     ├─ schemas/                # Zod：入站载荷、工作流输入输出、Provider 事件、内部 API
│     ├─ acl/                    # 内部 DTO ↔ Agent DTO
│     ├─ infrastructure/
│     │  ├─ database/            # agent_runs / agent_run_events / outbox 基础设施访问
│     │  ├─ llm/                 # 受控出网 + OpenAI-compatible 网关 + 凭据解密
│     │  ├─ mcp/                 # Tavily 远程 MCP 适配器
│     │  ├─ security/            # 密钥包装（Redacted）、严格 Base64 等
│     │  ├─ observability/       # 日志、指标、追踪
│     │  └─ cpu/                 # 有界 worker_threads 池（默认不启用）
│     └─ main/                   # dispatcher / worker / health 入口
└─ agent-worker/                 # Python：切换完成并度过观察期后删除（D1）
packages/
├─ contracts/                    # 继续作为契约事实源；需补 exports 与 TS DTO
└─ security-primitives/          # 新增：从 web 抽出的 AES-GCM 与内部密钥校验，Web 与 Worker 共用
```

配套改动：
- 根 `package.json` 增加 `dev:worker`、`build:worker`、`test:worker`、`typecheck:worker` 脚本（当前只有 web 脚本）。
- 新增 TS Worker 的 tsconfig、ESLint、Vitest 与 CI 流水线。
- `infra/compose.yaml` 与 `compose.production.yaml` 增加 TS Dispatcher/Worker 服务；灰度期 Python 三个服务保持不变；切换完成后移除 `agent-api`（FastAPI）与 `agent-celery-worker`。
- 环境变量：新增 `AGENT_*`，保留 `OUTBOX_*`、`MODEL_EGRESS_*`、`TAVILY_*`、`CREDENTIAL_ENCRYPTION_*`；`CELERY_*` 在切换完成后删除。

## 7. 队列、投递与灰度路由

### 7.1 Celery → BullMQ 语义映射

| 现状语义 | BullMQ 对应 | 必须注意 |
| --- | --- | --- |
| `acks_late` + `reject_on_worker_lost` | 运行中自动续租 + stalled 检测（`maxStalledCount`） | 机制不同：BullMQ 靠锁续租，不是可见性超时；必须验证长时间运行（含 SSE）期间不会误判 stalled |
| `visibility_timeout=660s` | `lockDuration ≥ 660000` | 保持“队列锁 > 硬超时”不变式 |
| `soft_time_limit=480s` | `AbortController` + 协作式取消检查 | 不得直接杀进程 |
| `time_limit=600s` | Worker 内硬超时看门狗 | 到点先中止外部请求、清理资源、写失败，再结束任务 |
| `max_retries=3`，退避 `min(300, 10×2ⁿ)` | `attempts=3` + 自定义 `backoffStrategy` | 必须封顶 300 秒且与现状同值 |
| `task_id = agent_run_id` | `jobId = agent_run_id` | 同时是 DB 幂等键；重复投递不得产生第二份业务结果 |
| `worker_prefetch_multiplier=1` | `concurrency` + `limiter` | BullMQ 无 prefetch 概念 |
| 无 Result Backend、忽略结果 | 不使用 Job 返回值 | 用户可见状态始终以 PostgreSQL 为准 |

### 7.2 Dispatcher 优雅关闭（D5，行为改进）

现状 `dispatcher.py` **没有任何 signal handler**：`main()` 只有 `logging.basicConfig` + `asyncio.run(run_dispatcher())`；未完成的事件只能等 900 秒锁租约；主循环在领取到事件时是忙循环（`claimed > 0` 不 sleep）。TS 版本必须实现：

1. 收到 `SIGTERM`/`SIGINT` 后**停止领取新批次**；
2. 等待在飞的“发布 + 回写”动作完成；
3. 把仍然持有锁但未发布完成的事件**主动回写**为 `failed` 且 `available_at = now()`（保留 `status='processing' AND locked_by = :dispatcher_id` 条件），避免等 900 秒；
4. 在 `AGENT_SHUTDOWN_GRACE_MS` 内完成上述动作，超时则以非零码退出并记录未处理事件 ID；
5. 空闲轮询仍为 1 秒，但连续领取到事件时继续立即下一轮（保留现状语义），同时补充最小退避避免空转打满 CPU。

### 7.3 Worker 优雅关闭（D5，行为改进）

1. 收到信号后停止取新任务，调用 `worker.close()` 等待在飞任务；
2. 在飞任务通过 `AbortController` 中止未完成的 HTTP/SSE 请求，并检查协作式取消；
3. **不得**在业务事务提交途中强杀进程：若任务已进入内部 API 回写，应让其完成；
4. 超过关闭窗口仍未结束的任务留给队列：BullMQ 会在锁过期后按 stalled 重新投递，而 PostgreSQL 的状态机保证不重复写业务结果；
5. 关闭窗口与 `stop_grace_period` 必须一致（现状 Worker 为 11 分钟，恰好覆盖 600 秒硬超时，迁移后必须保持同等覆盖）。

### 7.4 按 `run_type` 灰度路由（D3，零 Schema 变更）

Outbox 载荷刻意最小化，只有 `agent_run_id`/`trace_id`/`task_version`，不含 `run_type`。但 Dispatcher 有数据库权限，可以在领取阶段 join `agent.agent_runs` 得到 `run_type`，从而实现“同一张 Outbox、两个运行时、各自只领自己的任务”：

```sql
WITH candidate AS (
  SELECT o.id
  FROM public.outbox_events o
  JOIN agent.agent_runs r ON r.id = o.aggregate_id
  WHERE o.event_type = 'agent.run.requested'
    AND r.run_type = ANY(:run_types)          -- 运行时路由映射，唯一的路由开关
    AND (
      (o.status IN ('pending', 'failed') AND o.available_at <= now())
      OR (o.status = 'processing'
          AND o.locked_at < now() - (:lock_timeout_seconds * interval '1 second'))
    )
  ORDER BY o.created_at
  FOR UPDATE OF o SKIP LOCKED                  -- 关键：只锁 outbox，不锁 agent_runs
  LIMIT :batch_size
)
UPDATE public.outbox_events AS e
SET status = 'processing', locked_by = :dispatcher_id, locked_at = now(),
    attempt_count = e.attempt_count + 1, last_error = NULL
FROM candidate
WHERE e.id = candidate.id
RETURNING e.id, e.aggregate_id, e.event_version, e.payload_json, e.attempt_count;
```

实施要点：
- **`FOR UPDATE OF o` 不可省略**。若写成裸 `FOR UPDATE`，PostgreSQL 会同时锁住 `agent.agent_runs` 的行，而 Worker 的 `begin_execution` 也要对同一行取 `FOR UPDATE`，会把投递与执行串行化甚至阻塞。
- 该 join 让 Dispatcher 首次读取 `agent` schema，属**只读**新增访问；同一数据库账号已具备该权限，但需在迁移清单中显式确认，不新增任何写权限。
- 路由映射放在配置中（例如 `AGENT_RUNTIME_ROUTES={"assessment_generate":"ts","posttest_generate":"ts",...}`），Python Dispatcher 与 TS Dispatcher 读取**互斥**的集合；未列入任何运行时的 `run_type` 必须显式失败而不是静默滞留。
- 回滚：把映射改回 `{}`（TS 侧不再领取任何事件）并重启两个 Dispatcher 即可，**不需要数据库变更、不需要停机**；但**已经在 BullMQ 中的任务无法退回 Celery**，必须由 TS Worker 消费到空为止。
- 灰度期要求：两个 Dispatcher 的 `OUTBOX_DISPATCHER_ID` 必须不同；两侧的 `OUTBOX_*` 参数保持一致。

### 7.5 Redis 隔离与保留策略

- BullMQ 使用独立的键前缀（例如 `learncraft:agent-queue:`），**不得**与 Celery 的 `learncraft:celery:` 混用，也不得与认证限流 Redis 混用。
- 明确 completed/failed Job 的清理策略、死信审计与 Redis 内存上限；Tavily 每日配额继续使用独立键 `ratelimit:tavily:daily:<owner_id>:<UTC 日期>`。
- 配额计数建议改写为单条 Lua（`INCR` + 条件 `EXPIRE` + 超限 `DECR`）。现状只依赖 `INCR` 的原子性，`EXPIRE`/补偿 `DECR` 是独立命令，若进程在 `INCR` 后崩溃会留下**永不过期的键**。这是**语义改进**，需在实施时单独记录。

## 8. 高风险改造点

### 8.1 R1 受控模型出网（最高风险，阶段 3 门禁）

现状能力（`infrastructure/llm/`）：URL 只允许公网 HTTPS 443，禁止字面量 IP 与 localhost/数字域名；每次调用重新解析全部 DNS 并逐个用 `ipaddress.is_global` 校验，**任一结果不合格即整体拒绝**；以**已验证 IP** 作为连接目标（URL host 即 IP），同时通过 httpcore 扩展键 `request.extensions["sni_hostname"]` 保留原域名 TLS SNI 与证书校验；`follow_redirects=False`；响应体预检 + 流式累计限制 8MiB；**发请求前先写 `allowed` 审计，写失败即以 `MODEL_EGRESS_AUDIT_UNAVAILABLE` 拒绝（fail-closed）**。

TypeScript 实施要求：
- **不使用裸 `fetch(baseUrl)`**。候选实现为 `node:https`/`node:tls` 显式 `connect({ host: pinnedIp, servername: hostname, lookup: () => pinnedIp })`，或 undici `Agent({ connect: { servername } })`；undici 在 SNI/代理场景存在已知问题（undici issue #3401、PR #2939），两条路线都必须实测后再定。
- **Node 没有 `ipaddress.is_global`**：必须自建 CIDR 拒绝表，覆盖 `100.64/10`、`169.254/16`（含云元数据）、`192.0.0.0/24`、`198.18/15`、`240/4`、IPv4-mapped IPv6（`::ffff:10.0.0.1`）、NAT64 `64:ff9b::/96`、IPv6 ULA/link-local 等；漏掉任何一条都是 SSRF 回归。
- 重定向：`redirect: 'manual'` 并对 3xx 显式拒绝；**禁用自动解压或按解压后字节计数**，否则 gzip 炸弹可绕过响应上限。
- IDNA：Python 使用内置 IDNA2003 codec，Node 的 `domainToASCII` 是 UTS#46，边界域名归一化结果不同，需明确取舍并测试。
- 验收：把 `tests/unit/test_model_egress_policy.py`（≈259 行，覆盖 `:8443`、字面量 IP、`/v1/../admin`、私网 DNS 应答、pinned URL 精确等于 `https://8.8.8.8/v1/chat/completions` 等）逐条翻译为 Vitest，并新增 DNS rebinding、分块 SSE、缺 `[DONE]` 的可重试差异、超大响应、429/5xx、代理失败回归。
- **PoC 通过前，禁止给 TS Worker 配置真实用户 BYOK 密钥。**

### 8.2 R2 四个工作流显式建图

现状源码**没有任何 LangGraph/StateGraph 使用**（依赖已锁定但未使用，`infrastructure/checkpoint/` 是 6 行占位）。因此这不是“翻译现成的图”，而是**第一次显式建模**。建议：

- 图状态：`run`（id/owner/run_type/trace_id/逻辑会话键）、`input`（已校验快照）、`connection`（**仅运行内使用，绝不进入任何可持久化状态**）、`messages`（受限长度）、`tool_call_count`、`generation`、`validated_output`、`error`（稳定错误码）。
- 节点：`load_input → load_connection → generate_or_tool_loop → validate → repair / tavily_recovery → persist`；条件边依据 `validated_output`、错误类别与尝试次数转移，**不得出现无限循环**。
- 首期使用无持久化图执行；AgentRun、业务快照与幂等持久化仍是事实来源（D8）。
- 注意两个隐式契约：工作流直接调用了网关的私有方法 `_extract_json_text`（`plan_generate.py:294,347`、`card_content_generate.py:168,185`），迁移时必须提升为独立工具函数；`_normalize_double_escaped_markdown_newlines` 的触发条件也必须逐条保留。

### 8.3 R3 Tavily 远程 MCP

- Python 侧使用官方 MCP SDK 的 Streamable HTTP 传输并注入自定义 httpx 客户端（`trust_env=False`、四段超时 10/45/10/10、禁用重定向、走 `MODEL_EGRESS_PROXY_URL`）；TS 侧对应 `@modelcontextprotocol/sdk` 的 `StreamableHTTPClientTransport`，通过自定义 `fetch` 注入同等约束，**能力不完全等价，必须逐项验证**。
- 必须保留：工具名 `tavily_search`/`tavily-search` 兼容、只暴露 `tavily_search` 一个工具（`tavily_extract` 仅进程内调用）、执行期白名单校验、`isError` → `structuredContent` → `TextContent` 的读取顺序、结果截断（url 2048 / content 2000 / raw_content 1500）、`content_is_untrusted: true` 标记、整段最多 2 次尝试。
- 每次调用新建会话（无连接复用）是现状行为，若改为复用连接属行为变更，需单独确认。

### 8.4 R4 凭据解密（低风险，优先复用）

Web 侧**已有 TypeScript 实现**：`apps/web/src/lib/security/credential-crypto.ts`（AES-256-GCM，32 字节 Base64 密钥来自 `CREDENTIAL_ENCRYPTION_KEY`，IV 12 字节，认证标签 16 字节，AAD 精确为 `learncraft:model-connection:{owner_id}`，密钥版本来自 `CREDENTIAL_ENCRYPTION_KEY_VERSION`）。Python 侧解密时把 tag 拼接到密文尾部再交给 `AESGCM`，结果等价。

实施要求：
1. 把该实现抽到 `packages/security-primitives`（先在 `packages/contracts` 或新包补 `exports`），Web 与 Worker 共用**同一份代码**，不要重写第二份；
2. 补齐严格 Base64 校验（`Buffer.from(x,'base64')` 会忽略非法字符，与 Python 的 `validate=True` 不等价）；
3. 建立**跨语言测试向量**（现状不存在）：同一明文与 key 下 Python 加密 → TS 解密、TS 加密 → Python 解密，并覆盖空密钥、密钥长度错误、版本不匹配、IV/tag 长度错误、认证失败与 `UnicodeDecodeError` 等价错误码。

### 8.5 R5 Zod 与 Pydantic 的等价性

`extra="forbid"` → `.strict()`；`frozen=True` → `Object.freeze`；`SecretStr` 的“永不误打印”保证 Node 无等价物，需自建 `Redacted<T>`（`toJSON` 抛错 + 自定义 inspect）；`orjson` 的严格性（重复键、NaN、非可序列化对象行为）与 `JSON.parse/stringify` 不同；校验错误只暴露字段路径且**最多 8 条**、不含模型正文的既有契约必须保留。

### 8.6 R6 CPU 隔离与背压

- 主链路按 I/O 密集处理，全部走异步；`worker_threads` 只接收无密钥、可序列化、可取消、CPU 边界清晰的输入，使用固定池大小 + 单任务内存上限 + 执行时限 + 结果大小上限，**禁止每个 AgentRun 临时创建线程**。
- 背压：当队列等待超过 SLO 或 Provider 429 上升时，必须能以“降低并发/暂停领取”的方式回退，而不是无限堆积。

### 8.7 R7 可观测性

现状 Dispatcher 与 Worker **都没有 healthcheck，也没有指标**。迁移时至少补齐：队列长度、在飞任务数、各 run_type 的耗时分布、Provider 429/5xx 比例、工具调用次数、SSE 中断、事件循环延迟、RSS、PG 连接数、Outbox 积压与 `dead` 数量。指标是并压测与灰度的前置条件，不属可选优化。

## 9. 分阶段实施计划

| 阶段 | 目标 | 主要交付物 | 验收 | 人日 |
| --- | --- | --- | --- | --- |
| 0 | 冻结行为基线 | 记录当前 SHA、锁文件、环境变量默认值；四个 run_type 的输入/输出 Schema 与错误码清单；脱敏 golden fixtures；**实测** Python 侧并发与内存基线 | 有可重复执行的基线清单与压测报告；“行为兼容”有明确定义 | 3–5 |
| 1 | 建立并行 TS 工程骨架 | `apps/agent-worker-ts`、pnpm 接入、精确版本锁定、tsconfig/ESLint/Vitest/CI、最小 health 入口（中文文件头注释） | 可独立构建、测试、启动；**不写数据库、不调模型、不消费任务** | 3–5 |
| 2 | 契约、Schema 与基础设施 Port | 由 Web 侧 Zod 与 `packages/contracts` 生成/包装 DTO；`PgAgentRunRepository`（`begin_execution`、取消、事件序号、mark_*）；跨语言 AES-GCM 向量 | 运行时能拒绝非法结构；与现有密文互操作；Repository 覆盖并发领取与重复投递 | 10–15 |
| 3 | **安全出网 PoC（门禁）** | `ModelEgressPolicy` + 固定 IP/SNI/代理连接、SSE 有界聚合、错误分类、最小审计 | 第 8.1 节安全性质全部可自动测试；与 Python 错误码、可重试性一致 | 15–25 |
| 4 | Dispatcher + BullMQ + 路由 | `SKIP LOCKED` 领取（含 `FOR UPDATE OF o` 路由 SQL）、锁超时回收、退避、**优雅关闭**；按 `run_type` 的运行时路由 | 端到端处理模拟 AgentRun；重复消息不产生重复业务结果；两种关闭路径均有测试 | 5–8 |
| 5 | 四个工作流按风险从低到高重建 | `assessment_generate` → `posttest_generate` → `plan_generate` → `card_content_generate` 的 LangGraph.js 图 | 每个 run_type 的成功/失败/重试/取消/幂等路径全通过；golden fixtures 回放一致 | 35–50 |
| 6 | 压测与容量配置 | 1/2/4 副本 × 不同 concurrency 的压测报告；Provider 与用户级限流；初始并发与扩容规则 | 有明确上线初值；未突破 Provider、数据库、Redis、内存与成本预算 | 5–8 |
| 7 | 影子验证与灰度 | 脱敏 fixtures/测试账户下的影子执行；按 `run_type` 逐类切换 | 无重复业务写入、无密钥泄露、无未解释的 Schema 回归 | 5–10 |
| 8 | 切换、观察、退役与文档 | 停止 Python 三个进程；删除 Celery 依赖与 Redis 键；同步技术栈/架构/部署/运维/事故文档 | 生产不再依赖 Python；所有历史任务可追踪归属 | 5–8 |
| | | | **合计** | **≈ 85–135 人日** |

单人全职约 4–6.5 个月；两人并行（一人负责 8.1 出网 PoC 与基础设施，一人负责工作流）约 10–14 周。**阶段 3 是唯一可能在 PoC 失败后推翻技术选型的阶段，建议最先启动。**

## 10. 测试与验收矩阵

| 层级 | 必测内容 |
| --- | --- |
| 单元测试 | Zod Schema、错误分类、退避封顶、工具调用上限与回填语义、工作流条件边、取消检查、优雅关闭路径、线程池输入输出边界 |
| 安全测试 | 跨语言 AES-GCM 向量、DNS/私网/重定向阻断、固定 IP + SNI 证书校验、代理、超大与压缩响应、SSE 分块与缺 `[DONE]`、日志脱敏 |
| 契约测试 | `agent-run-requested.v1`、5 个内部端点请求/响应、`output_summary_json` 键、稳定错误码、snake_case 字段、strict 校验 |
| 数据库集成测试 | Outbox 原子创建、`SKIP LOCKED` 并发领取、`FOR UPDATE OF o` 不影响 `begin_execution` 行锁、重复投递、事件序号、幂等业务写入 |
| 队列集成测试 | Redis 不可用、发布后崩溃、延迟重试、Worker 崩溃与 stalled 重投、两种优雅关闭、死信与保留策略 |
| 工作流回归测试 | 四个 run_type 的首轮成功、工具循环、修复、Tavily 兜底、无资料重建、无效输入、取消、可重试与不可重试失败 |
| E2E 测试 | 创建目标 → 前测 → 评分 → 路线 → 节点内容 → 后测全链路；浏览器只看到通过校验的最终产物 |
| 性能/稳定性 | 队列等待、p95、429 比例、RSS、事件循环延迟、PG 连接、Redis 内存、单次运行成本、24 小时稳定性 |

模型输出**不适合**作为逐字回归基线。验收比较的是：题目数量与选项/答案关系、路线节点数与依赖无环、内容必填字段与来源合同、持久化幂等性、错误码、工具调用次数、密钥不泄露与用户可见状态。

## 11. 发布、灰度与回滚

1. 灰度以 `run_type` 为单位，**同一个 AgentRun 永远只属于一个运行时**（由 Dispatcher 的领取条件保证）。
2. 发布顺序：先发布 TS Dispatcher 与 Worker（路由映射为空，不领取任何事件）→ 确认健康与指标 → 把 `assessment_generate` 加入 TS 映射并重启 Dispatcher → 观察 → 依次加入 `posttest_generate`、`plan_generate`、`card_content_generate`。
3. 回滚：把 TS 侧的 `run_type` 集合清空并重启两个 Dispatcher。**已在 BullMQ 中的任务必须由 TS Worker 消化至终态**，不能切回 Python；因此回滚前应确认 TS Worker 仍在线。
4. 数据不变：`agent.agent_runs`、`agent.agent_run_events`、`public.outbox_events` 历史、学习目标/路线/题集/卡片内容、已加密的用户 API Key、v1 契约均不迁移、不改写。
5. Python 退役条件：四个 `run_type` 稳定运行达到约定观察期、Celery 队列与非终态任务清零、`dead` 事件人工处理完毕。

## 12. 风险清单

| 风险 | 错误做法 | 必须采取的处理 |
| --- | --- | --- |
| 认为“换 TS 就更快” | 迁移后不配置并发、限流与副本 | 第 3 节容量设计与阶段 6 压测；并发由配置决定 |
| 认为 Node 天然擅长 CPU | 省略线程池与背压设计 | 8.6：CPU 密集一律移出主线程，默认关闭线程池 |
| 安全能力退化 | 对用户 Base URL 用普通 `fetch` 或官方 SDK | 8.1 门禁；未通过不得接真实用户 Key |
| 路由 SQL 引入锁竞争 | `FOR UPDATE` 不加 `OF o`，锁住 `agent_runs` | 严格使用 `FOR UPDATE OF o SKIP LOCKED`，并做并发回归测试 |
| 业务重复写入 | 两个运行时同时执行同一 AgentRun | 领取条件互斥；DB 状态机仍是最终幂等边界 |
| 结果逐字不一致被误判为失败 | 把采样差异当成迁移缺陷 | 只比较契约、不变量、持久化、错误码与安全行为 |
| 优雅关闭导致重复执行 | 关闭时强杀正在回写的任务 | 关闭窗口覆盖硬超时；让任务完成或由 stalled 重投 |
| 迁移期 Python 继续扩张 | 新功能写进 Python Worker | Python 冻结：除本方案明确要求的“Dispatcher 增加 run_type 过滤”外不再新增功能 |
| 契约文档继续漂移 | 直接照抄 `core.yaml` 实现 TS 客户端 | 以 Web 实现为唯一事实源；先执行第 13 节修正 |
| Python 能力断档 | 直接删除 Python 后才发现需要文档解析/OCR/embedding | D1 已确认不留 Python；`infrastructure/{document_parsers,embeddings,retrieval}` 目前均为空占位，未来能力必须以 TS 或独立服务实现，**必须在使用前单独决策** |

## 13. 契约文档漂移修正记录

`packages/contracts/openapi/core.yaml` 与实际实现存在三处漂移，已在本版一并修正（以实现为事实源）：

| 项目 | 修正前 | 修正后 | 依据 |
| --- | --- | --- | --- |
| 内部鉴权头名 | `securitySchemes.internalServiceToken.name: X-Internal-Service-Token` | `X-LearnCraft-Internal-Secret` | Python 客户端 `acl/web_core_internal_client.py` 与 Web 端 5 个 route 均使用 `x-learncraft-internal-secret` |
| 内部回写端点 | 只有 `/internal/v1/agent-runs/{id}/results`（**实现中不存在**） | 删除该端点，补入实际存在的 `default-model-connection`、`assessment-result`、`plan-result` | 实际实现为 5 个内部端点，见 5.2 |
| 内部错误响应 | 复用公共对象信封 `ErrorResponse{error:{code,message,trace_id}}` | 内部端点改用字符串码信封 `InternalErrorResponse{error: "CODE", field_errors?: [...]}`；公共 `ErrorResponse` 保持不变 | 公共 API 经 `apiErrorResponse` 返回对象信封（`modules/identity/interfaces/auth-http.ts:81-102`）；内部端点为 `NextResponse.json({ error: "CODE" })` |

**未做的事**：没有为内部端点补齐完整的请求体 Schema 副本。这些载荷与 Web route 内的 Zod strict schema 一一对应，在 `core.yaml` 中重复定义只会产生新的漂移；修正记录在对应 path 的 `description` 中指向实现文件。

## 14. 完成定义

同时满足以下条件才可宣告迁移完成：

1. Web、Dispatcher、Agent Worker、模型网关、工具网关与四个业务工作流均由 TypeScript/Node.js 运行；
2. 四个 `run_type` 全部以 LangGraph.js 图实现，并通过 Zod 与契约测试；
3. Celery、Python Agent Worker、FastAPI Agent API 的生产职责已移除，镜像与依赖清理完毕；
4. AgentRun/Outbox/业务写入/模型密钥/安全出网/取消/重试/审计的验收项全部通过；
5. 完成压测并给出受 Provider 配额约束的并发配置；
6. 完成观察期，无未解释的重复执行、数据不一致、密钥暴露、安全绕过或显著成本回归；
7. 代码、Compose、环境变量、CI、运行手册与架构文档均反映 TypeScript 单语言常态架构；`docs/01`、`docs/04`、`docs/05`、`apps/agent-worker/README.md` 中的 Python/双栈表述已同步更新。

## 15. 仍待确认的决策

| 编号 | 待确认事项 | 推荐方向 | 影响 |
| --- | --- | --- | --- |
| D7 | 出网实现路线（`node:https` vs undici `Agent`） | 阶段 3 两条都做 PoC，取能同时满足“固定 IP + 原域名 SNI/证书 + 代理”的那条 | 直接决定 SSRF 防护与 BYOK 密钥安全 |
| D8 | 是否引入 LangGraph.js 持久化 Checkpointer | 首期不引入；后续单独确认表结构、`thread_id` 规则、留存与隐私策略 | 涉及数据库 Schema、数据留存与恢复语义 |
| D9 | `worker_threads` 使用范围 | 仅纯 CPU 子任务，有界常驻池，默认不启用 | 影响内存、故障隔离与代码复杂度 |
| D11 | Tavily 配额是否改为单条 Lua | 建议改（修掉无 TTL 残留窗口），但属语义变更 | 影响配额精确性，需回归 |
| D12 | 混合时钟统一策略（进程时钟 vs 数据库 `now()`） | 统一使用数据库时间，避免 `available_at` 与 `finished_at` 矛盾 | 影响 Outbox 与状态机语义 |
| D13 | 最终目录：是否在观察期后把 TS 工程重命名为 `apps/agent-worker` | 建议重命名并删除 Python 目录，保持仓库整洁 | 影响仓库结构与历史引用 |
