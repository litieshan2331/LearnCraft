# LearnCraft Agent Worker

## P0 assessment_generate 工作流

当前已接入前测与后测题集生成：Worker 从 `agent.agent_runs.input_summary_json` 读取主题、题量、难度和测验类型，向 Web 内部接口读取账户默认模型连接，使用 `ModelCredentialDecryptor` 解密 API Key，再通过 `OpenAiCompatibleModelGateway` 调用模型。

模型首轮被要求调用 `tavily_search`。Worker 内部通过官方远程 HTTP MCP 先执行 Search，再对排名靠前的两个结果执行 Extract；模型只看见 `tavily_search` 这一个工具。单次 AgentRun 的硬上限位于 `src/learncraft_agent/application/services/tool_aware_generator.py` 的 `ToolAwareGenerator.generate`，由 `AGENT_TOOL_MAX_CALLS` 配置，默认值为 3 且配置层不允许超过 3。达到上限后会移除工具并发送 `tool_choice=none`，让模型基于已有结果完成最终 JSON。

Tavily 网关还使用 DB 0 的 Celery Redis 记录 `ratelimit:tavily:daily:<owner_id>:<UTC 日期>`，默认每个用户每天最多 20 次可见 Tavily 工具调用。额度耗尽或配额 Redis 不可用时，不会绕过限制访问网络，结构化错误会作为 tool result 返回模型。

题集经 Pydantic 校验后，通过 `POST /internal/v1/agent-runs/{agentRunId}/assessment-result` 交给 Web 在一个事务中幂等写入 `assessments` 和 `assessment_items`；Worker 不直接写 Web 核心业务表。需要启用真实生成时，在 `infra/.env` 填写 `TAVILY_API_KEY`、`CREDENTIAL_ENCRYPTION_KEY`，并将 `MODEL_EGRESS_ENABLED=true`。

`learncraft-agent` 是 LearnCraft 的 Python Agent 运行时，使用 FastAPI、Celery、LangGraph、SQLAlchemy 与 Pydantic。它不持有用户、学习目标、路线、题目等核心业务写模型。

当前由同一个 Docker 镜像运行三个职责明确的进程：

- `agent-api`：仅内网 FastAPI，当前提供 `GET /health`，后续承接受鉴权的内部接口。
- `agent-dispatcher`：使用 PostgreSQL `public.outbox_events` 的 `FOR UPDATE SKIP LOCKED` 领取 `agent.run.requested`，投递到 Celery。
- `agent-celery-worker`：消费 `agent.run` 队列，维护 `agent.agent_runs` 与 `agent.agent_run_events` 的运行状态、重试和协作式取消检查。

## 消息与可靠性边界

Web 必须在创建 `AgentRun` 的同一 PostgreSQL 事务中写入 Outbox。Dispatcher 即使在发送 Celery 消息后崩溃，也可能再次投递同一个 `agent_run_id`；因此 Worker 将该 ID 同时作为 Celery `task_id` 和持久化幂等边界。

当前已实现 `assessment_generate` 工作流；公开 AgentRun 创建 API 仍是后续 Web 任务。`plan_generate`、卡片内容和自适应工作流仍会在未注册时以 `AGENT_RUN_WORKFLOW_NOT_REGISTERED` 失败，绝不会伪造成功结果。

## 用户模型凭据边界

生成任务当前按账户默认连接读取模型。用户 Provider API Key 由 Web 以 AES-256-GCM 密文存入 `user_model_connections`；Worker 仅在执行时使用与 Web 相同的 `CREDENTIAL_ENCRYPTION_KEY` 解密，Celery 消息、日志和 AgentRun 只携带连接 ID 与模型名。用户 Base URL 只允许公网 HTTPS 域名和 443 端口；真实调用必须经 `SafeModelEgressClient`：每次复核全部 DNS 结果、禁止 IP 字面量及私网地址、以已验证 IP 连接、保留 TLS SNI、拒绝重定向、限制响应体并写入 30 天最小审计。`assessment_generate` 已通过 `ModelGateway` 接入真实模型调用。

Celery 不启用 Result Backend。用户可见状态、运行事件、错误和后续结果始终以 PostgreSQL 为事实来源；Redis 只作为 Broker，且与认证限流 Redis 分离。

## 本地命令

在 `apps/agent-worker/` 目录执行：

```powershell
# 代码风格与单元测试
uv run ruff check src tests
uv run pytest

# 仅启动 FastAPI Agent API
uv run learncraft-agent

# 仅启动 Outbox Dispatcher（需先设置 DATABASE_URL 与 CELERY_BROKER_URL）
uv run learncraft-agent-dispatcher

# 仅启动 Celery Worker（需先设置 DATABASE_URL 与 CELERY_BROKER_URL）
uv run celery -A learncraft_agent.core.celery_app:celery_app worker --loglevel=INFO
```

通常不需要手工分别启动后三者；本地使用 `infra/compose.yaml`，Docker Compose 会注入连接信息并启动它们。

## 数据库边界

P0 的全部数据库迁移仍由 Web 侧 Drizzle 维护。Python SQLAlchemy 只映射 `agent.agent_runs` 与 `agent.agent_run_events`；Dispatcher 对 `public.outbox_events` 使用参数化 SQL 更新投递状态。学习目标、路线、测验、内容等核心表仍只能通过 Web 的内部应用服务/API 写入。
