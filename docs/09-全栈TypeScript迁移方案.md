# LearnCraft 全栈 TypeScript 迁移：剩余待办

> **运行时迁移已经完成**：四个 P0 工作流（前测 / 后测 / 学习路线 / 节点内容）、Tavily 远程 MCP、
> BullMQ 投递、受控模型出网、凭据解密与健康端点全部由 TypeScript 运行；Python 三个进程已从编排、
> 环境变量与镜像定义中移除，`apps/agent-worker` 仅作参照保留（无配置、无执行）。
>
> 本文只保留**尚未完成的工作**、执行它们所需的参考数据，以及仍待确认的决策。
> 已完成部分的实施记录与决策依据见 git 历史、`infra/README.md`、
> `apps/agent-worker-ts/README.md` 与各目录 README。

## 一、待办清单（按建议优先级）

| # | 待办 | 量级 | 阻塞关系 |
| --- | --- | --- | --- |
| 2 | 失败重试与运行中取消的端到端用例 | 0.5–1 人日 | 无 |
| 3 | 阶段 6：压测与容量定值 | 8–12 人日 | 需要先定压测环境与目标档位 |
| 4 | 阶段 0 遗留：行为基线与 golden fixtures | 2–3 人日 | 无 |
| 5 | 工程化零碎项：worker ESLint、contracts DTO 生成 | 各 0.5 人日 | 无 |
| 6 | 阶段 7：影子验证（可选） | 2–3 人日 | 建议在 #3 之后 |
| 7 | 可选架构演进：LangGraph.js 图化 | 视需要 | 需先决策 D8 |
| 8 | P1 功能：embedding/向量检索、adaptation、code runner | 独立排期 | 属新功能，非迁移欠账 |

> 原 #1「观察期：真实业务跑通四个工作流」已完成（后端链路的四个 `run_type` 已分别真实跑通），
> 其小节已删除；剩余编号保持不变，以保留文内对 #3 的引用。

### 2. 失败重试与运行中取消的端到端用例

现状覆盖：错误分类、退避封顶、processor 的两个 throw 分支、repository 终态短路与 `shouldExecute`
已在单元测试覆盖；真实端到端只验证了成功路径与幂等（重复投递 `skipped/already_finished`）。

缺口（跨进程 + 真数据库 + 真队列从未跑过）：

1. 可重试失败 → 数据库记 `failed` + 下一次重试 → BullMQ 按退避重投 → 第二次尝试成功；
2. Web 置 `cancelled` 后 Worker 领取即跳过，且**零业务写入**；对已取消运行重复投递仍跳过；
3. 失败路径下的 `agent_run_events` 序列与 `retry_count` 递增。

做法（不消耗模型费用）：

- 新增本地 stub 模型服务（`node:http`，可编排返回 5xx / 超时 / 正常），把 fixture 的
  `user_model_connections.base_url` 指向它；
- 重试用例：stub 先返 503 → 投递 BullMQ（`maxAttempts=2`、backoff 1s）→ 断言第 1 次后
  `status=failed`、`retry_count=1`、事件含 `run.started`；stub 切正常后断言第 2 次 `succeeded`、
  事件含 `run.resumed`、业务结果只落库 1 份；
- 取消用例：投递后立即 `UPDATE agent.agent_runs SET status='cancelled'` → 断言 Worker 返回
  `skipped/cancelled`、`assessments` 计数为 0、无 `run.succeeded` 事件；
- 全程 gated（`AGENT_TS_LIVE_E2E=1` 等），默认跳过；夹具沿用「锚点 + 数量守卫 + 事务清理」方式。

边界：证明的是「本地真实栈上路径正确」，**不能替代** #3 的压测数据。

### 3. 阶段 6：压测与容量定值

按四档分别压测，观察队列等待、AgentRun p50/p95、429 比例、RSS 与单位并发成本、
PostgreSQL 连接数与使用率、Redis 内存、egress proxy 并发与带宽、事件循环延迟
（`perf_hooks.monitorEventLoopDelay`）。**没有实测数据的并发档位不得上线。**

| 档位 | 对应注册用户 | 换算峰值并发 | 副本数 × 每副本并发 | 部署峰值上限 | 前置条件 |
| --- | --- | --- | --- | --- | --- |
| 初始上线 | ≤ 1 万 | ≤ 15 | 2 × 10 | 20 | 先证明行为正确与幂等边界 |
| 增长期 | 1 万 – 5 万 | 15 – 75 | 4 × 25 | 100 | 必须已有 Provider 限流与数据库连接预算 |
| **目标规模** | **5 万 – 10 万** | **75 – 150** | 6 × 25 | 150 | 必须完成多机部署与下列全部瓶颈项 |
| 扩容余量 | 10 万以上 | 150 – 300 | 8–10 × 40–50 | 300–500 | 需重算并发假设并重新评估数据库、代理与成本预算 |

压测前必须先设计的瓶颈项：

1. 连接池按**事务并发**设置（约 12/副本），总量 ≤ `max_connections` 的 60%，超出则引入 PgBouncer；
2. Provider 与账户级限流（429 比例作为容量边界之一）；
3. 出网代理的并发、带宽与超时计入容量表，且不得绕过代理；
4. `agent.agent_run_events` 的留存、归档与分区策略（目标规模约 15–29 万行/日）；
5. 事件循环延迟与 CPU 隔离：CPU 密集任务一律移出主线程，`worker_threads` 默认不启用；
6. Redis 内存与保留策略（BullMQ 队列、Tavily 配额键、认证限流键）。

出口：给出各档的并发配置与扩容规则，并把实测结论回写到本表；参数全部由环境变量注入，禁止硬编码。

### 4. 阶段 0 遗留：行为基线与 golden fixtures

- 产出四个 `run_type` 的**脱敏 golden fixtures**（输入快照 + 期望输出摘要 + 错误码），并提供回放对比脚本；
- 回放时只比较契约、不变量、持久化结果、错误码与安全行为，**不比较逐字文本**；
- 下表差异是**有意为之**，回放时应作为白名单而不是缺陷：

| 差异 | 内容 |
| --- | --- |
| Token 用量写真实值 | Python 恒定写 `0/0`；TS 写入跨阶段累计的真实用量，`output_summary_json` 仍保持原有键集合 |
| 校验更严 | zod 的 UUID 校验含 RFC 版本与变体位、`skill_tags` 元素长度受限，与 Web 路由（最终裁判）一致 |
| 时间源统一 | TS 统一使用数据库 `now()`，避免 `available_at` 与 `finished_at` 矛盾 |
| 单会话 ReAct（2026-09-18 用户确认） | 四个工作流由「按阶段重建消息列表 + 追加上一轮原文与修复指令 + 分阶段工具开关」改为**单一 persona 的持续累积会话**：工具成功/失败都回传同一会话，校验失败回灌字段路径自纠；轮数上限按工作流注入（`AGENT_REACT_MAX_TURNS_*`，默认 5/5/10/5）；最终 JSON 不再用 `response_format` 而是提示词 + `extractJsonText`；后测全程开放联网（产品边界变更）；模型网关错误直接上抛交给任务级重试。元数据键不变、取值语义映射，Web 无需改动 |

### 5. 工程化零碎项

- `apps/agent-worker-ts` 引入 ESLint（当前只有 tsc + Vitest）；
- `packages/contracts/ts` 的 DTO 生成或包装（当前 TS 契约是手写 zod，`ts/` 目录仍只有 README）。

### 6. 阶段 7：影子验证（可选）

用脱敏 fixture 与测试账户并行对拍新旧实现；当前已用「真实灰度 + 观察」替代，未做影子执行。

### 7. 可选架构演进：LangGraph.js 图化

Python 源码从未引用 `langchain`/`langgraph`（仅在 `pyproject.toml` 声明），因此这不是既有行为的迁移欠账，
而是可选的架构演进。若实施：先把四个工作流的显式实现替换为图，并按 D8 决定是否引入持久化 Checkpointer。

2026-09-18 起四个工作流已是**单会话 ReAct**（`runReactAgentSession`：消息累积 + 工具循环 + 校验反馈），
图化的收益主要是可视化与可选 Checkpointer，不再是动态行为上的缺口。

### 8. P1 功能（非迁移欠账）

embedding / 向量检索（pgvector；`infrastructure/{embeddings,retrieval}` 目前是空占位）、adaptation、
code runner。任一能力落地前必须单独确认 Provider、模型、维度与版本。

## 二、仍待确认的决策

| 编号 | 待确认事项 | 推荐方向 | 影响 |
| --- | --- | --- | --- |
| D8 | 是否引入 LangGraph.js 持久化 Checkpointer | 首期不引入；后续单独确认表结构、`thread_id` 规则、留存与隐私策略 | 涉及数据库 Schema 与恢复语义 |
| D9 | `worker_threads` 使用范围 | 仅纯 CPU 子任务，有界常驻池，默认不启用 | 影响内存、故障隔离与复杂度 |
| D11 | Tavily 配额是否改为单条 Lua | 建议改（修掉无 TTL 残留窗口），属语义变更需回归 | 影响配额精确性 |
| D12 | 混合时钟统一策略 | TS 已统一使用数据库时间；若后续新增时间字段需保持一致 | 影响 Outbox 与状态机语义 |
| D13 | 是否把 TS 工程重命名为 `apps/agent-worker` | 观察期后重命名并删除 Python 目录，保持仓库整洁 | 影响仓库结构与历史引用 |
| D14 | `agent.agent_run_events` 的留存、归档与分区策略 | 目标规模上线前确定（约 15–29 万行/日） | 属数据治理，必须先于 #3 定档 |

## 三、执行待办时必须遵守的既有约束

- **安全**：用户 Base URL 只能经 `SafeModelEgressClient` 调用（IP 段校验、固定 IP + 原域名 SNI、拒绝重定向、响应体上限、审计 fail-closed）；Tavily 只走固定官方 MCP，配额 Redis 不可用时拒绝联网而不是绕过；
- **队列语义**：领取必须使用 `FOR UPDATE OF o SKIP LOCKED`（漏掉 `OF o` 会锁住 `agent_runs` 并与 `begin_execution` 互相阻塞）；
- **幂等**：终态短路 + `agent_run_id` 作为 dedupe 键，任何新增路径都必须保持「重复投递不产生重复业务写入」；
- **配置**：并发、超时、退避、工具上限等一律由环境变量注入，禁止硬编码；
- **契约**：Web 实现是唯一事实源，内部端点为 5 个（详见 `apps/web/src/app/internal/v1`）。

## 四、验收矩阵中仍未覆盖的行

| 层级 | 未覆盖内容 |
| --- | --- |
| 工作流回归 | 失败重试、运行中取消、golden fixtures 回放（成功路径、工具循环、修复与兜底、无效输入已覆盖） |
| 队列集成 | 延迟重试的完整链路、Worker 崩溃后的 stalled 重投、死信与保留策略（发布后崩溃与两种优雅关闭已覆盖） |
| 数据库集成 | 事件表长跑增长与留存策略（并发领取、重复投递、事件序号已覆盖） |
| E2E | 浏览器侧全链路冒烟（后端链路的四个 `run_type` 已分别真实跑通） |
| 性能/稳定性 | 全部指标（见 #3）；24 小时稳定性 |
