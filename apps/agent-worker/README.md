# LearnCraft Agent Worker

`learncraft-agent` 是 LearnCraft 的 Python Agent 运行时，使用 FastAPI、Celery、LangGraph、SQLAlchemy 与 Pydantic。它不持有用户、学习目标、路线、题目等核心业务写模型。

当前由同一个 Docker 镜像运行三个职责明确的进程：

- `agent-api`：仅内网 FastAPI，当前提供 `GET /health`，后续承接受鉴权的内部接口。
- `agent-dispatcher`：使用 PostgreSQL `public.outbox_events` 的 `FOR UPDATE SKIP LOCKED` 领取 `agent.run.requested`，投递到 Celery。
- `agent-celery-worker`：消费 `agent.run` 队列，维护 `agent.agent_runs` 与 `agent.agent_run_events` 的运行状态、重试和协作式取消检查。

## 消息与可靠性边界

Web 必须在创建 `AgentRun` 的同一 PostgreSQL 事务中写入 Outbox。Dispatcher 即使在发送 Celery 消息后崩溃，也可能再次投递同一个 `agent_run_id`；因此 Worker 将该 ID 同时作为 Celery `task_id` 和持久化幂等边界。

当前尚未实现具体的 LangGraph 工作流和 AgentRun 创建 API。因而系统不会自行产生任务；若人为插入一个有效的 `agent.run.requested` 事件，Worker 会记录运行开始后以 `AGENT_RUN_WORKFLOW_NOT_REGISTERED` 失败，绝不会伪造成功结果。

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
