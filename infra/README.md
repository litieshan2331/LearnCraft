# LearnCraft 本地基础设施

## Agent 生成相关配置

开发 Compose 会把 `TAVILY_API_KEY`、`TAVILY_QUOTA_REDIS_URL` 和工具预算注入 `agent-celery-worker`。Tavily 使用 Celery Redis 的 DB 0，但通过 `ratelimit:tavily:daily:` 前缀与 Celery Broker key 区分；`TAVILY_DAILY_TOOL_CALL_LIMIT` 默认是 20，`AGENT_TOOL_MAX_CALLS` 开发默认是 6，配置层最大值也是 6。工具调用的执行位置是 `apps/agent-worker/src/learncraft_agent/application/services/tool_aware_generator.py`。

`assessment_generate`、`plan_generate`、`card_content_generate` 和 `posttest_generate` 的结果均由 Worker 通过内部共享密钥提交到 Web；Web 才负责在事务中写入业务表。首次联调前，请在 `infra/.env` 设置 `CREDENTIAL_ENCRYPTION_KEY`，确认 `MODEL_EGRESS_ENABLED=true`，并确保账户存在 active 且 default 的模型连接。只有实际调用联网工具时才需要 `TAVILY_API_KEY`；Tavily Key 或配额 Redis 不可用时，工具调用会返回受控错误给模型，不会绕过工具限制。

`compose.yaml` 提供 P0 本地开发与联调基线：PostgreSQL + pgvector、认证限流 Redis、独立的 Celery Redis Broker、MinIO、Web、Agent API、Python 侧的 Outbox Dispatcher 与 Celery Worker，以及 TypeScript 侧的 `agent-dispatcher-ts` 与 `agent-worker-ts`。两套运行时通过 `AGENT_RUNTIME_ROUTES` 划分 `run_type` 归属：本地默认留空，全部由 Python 领取（等价于未迁移状态）。Web 默认使用 `next dev` 并挂载前端源码，以支持热更新。它不自动执行 Drizzle 迁移、不启动代码 Runner；配置凭据密钥和模型出网后，可运行四个已注册的 P0 Agent 工作流。
Python Agent 的开发源码 `apps/agent-worker/src` 同样会被挂载：`agent-api` 使用 Uvicorn 重载，`agent-dispatcher` 与 `agent-celery-worker` 使用 `watchfiles` 重启各自的子进程。保存 `.py` 文件不需要重启 Docker 容器，也不会自动执行数据库迁移。

`private` 是本地开发服务的共享网络，并不自动将端口开放给宿主机；是否可从 Windows 访问仍只由服务的 `ports` 配置决定。当前 Web、PostgreSQL、MinIO 与 Agent Worker 都绑定到 `127.0.0.1`，只供本机开发调试，不向局域网暴露。

## 本地启动

环境变量文件与 `compose.yaml` 位于同一目录，Docker Desktop 可自动读取。先进入 `infra/`，复制环境变量示例并替换本机密码：

```powershell
Set-Location infra
Copy-Item .env.example .env
```

随后仍在 `infra/` 目录执行：

```powershell
docker compose config
docker compose up --build -d
docker compose ps
```

日常可在 Docker Desktop 的 LearnCraft Compose 应用中直接启动、停止或重启服务。首次启动，或 Dockerfile、依赖、`compose.yaml` 改动后，需要在 Docker Desktop 重新构建镜像，或执行 `docker compose up --build -d`。请勿随意删除 Compose 应用；停止服务不会移除数据库和 MinIO 的命名卷。

## Web 与 Python Agent 热更新开发模式

本地 `compose.yaml` 已直接采用开发模式：Web 使用 `next dev`，并挂载 `apps/web` 与 `packages/contracts`。日常开发只使用这一份 Compose 文件，不再使用 `compose.dev.yaml`；因此保存 `apps/web/src` 下的 `.ts`、`.tsx` 或 `.css` 文件后，Next.js 会执行 Fast Refresh。
保存 `apps/agent-worker/src` 中的 `.py` 文件后，`agent-api` 会由 Uvicorn 自动重载；`agent-dispatcher` 和 `agent-celery-worker` 会由 `watchfiles` 优雅重启其子进程，Docker 容器本身保持运行。正在执行的 AgentRun 可能因 Worker 子进程重启而中断并按既有重试策略恢复，因此联调中的长任务应避免在保存时依赖不中断执行。

`apps/agent-worker/pyproject.toml`、`uv.lock`、Dockerfile、`compose.yaml` 或环境变量变更仍需执行 `docker compose up --build -d`；数据库迁移继续由手动执行的 `pnpm db:migrate` 管理。


在仓库根目录执行：

```powershell
docker compose -f infra/compose.yaml up --build -d web
```

随后访问 `http://127.0.0.1:3000`。修改路由布局、服务端组件等文件时，浏览器发生完整页面刷新也属于正常行为。开发模式将依赖目录和 `.next` 缓存保存在 Docker 命名卷中，不会污染宿主机源码目录。

以下变更会影响容器或依赖，仍需重复执行上面的 `up --build` 命令：`package.json`、`pnpm-lock.yaml`、Dockerfile、Compose 配置，以及需要重新读取的环境变量。真正的生产部署始终使用独立的 `compose.production.yaml`，其中 Web 使用 `next start` 且不挂载源码，不需要手工回改本地 `compose.yaml`。Windows 上通过 Docker Desktop 挂载源码时，文件变更检测通常可用，但性能可能低于直接在宿主机运行 `next dev`；这是 Next.js 官方文档列出的 Docker 开发环境限制之一。当前项目优先使用上述容器开发模式，以保持 Web 与 Docker 内部服务的网络配置一致。[Next.js 本地开发指南](https://nextjs.org/docs/app/guides/local-development)

| 服务 | 本机地址 | 用途 |
| --- | --- | --- |
| Web | `http://127.0.0.1:${WEB_PORT}` | 浏览器访问 LearnCraft Web。 |
| PostgreSQL | `127.0.0.1:${POSTGRES_HOST_PORT}` | VS Code 数据库扩展与本机 SQL 工具。 |
| Redis | `127.0.0.1:${REDIS_HOST_PORT}` | 认证限流与本机 Redis 工具调试。 |
| Celery Redis | `127.0.0.1:${CELERY_REDIS_HOST_PORT}` | Celery Broker 与本机队列调试。 |
| MinIO API | `http://127.0.0.1:${MINIO_API_HOST_PORT}` | S3 兼容对象存储 API。 |
| MinIO 控制台 | `http://127.0.0.1:${MINIO_CONSOLE_HOST_PORT}` | 在浏览器查看 Bucket 与对象。 |
| Agent API | `http://127.0.0.1:${AGENT_WORKER_HOST_PORT}` | 独立调用健康检查与后续内部接口调试。 |

上述端口均绑定 `127.0.0.1`，不会向局域网公开。认证 Redis 只用于 Web 认证限流；Celery Redis 只作为任务 Broker；两者均固定 DB 0，但物理实例与密码独立。业务数据、Session 与 Outbox 仍存 PostgreSQL。MinIO 仅供本地 P0 使用，上线时替换为托管 S3/R2；生产环境仅映射 Web 端口，Agent API、Dispatcher 与 Celery Worker 通过内部网络调用。

## 认证本地配置

`APP_ORIGIN` 是认证写接口允许的浏览器来源。本地固定为 `http://127.0.0.1:3000,http://localhost:3000`，两个地址均可分别调试；值只能是以英文逗号分隔的 Origin，不能附带路径。`SESSION_COOKIE_SECURE=false` 仅适用于本地 HTTP；部署到 HTTPS 的 staging 或 production 时，必须改为 `true`，并只填写实际部署域名。

MinIO 控制台使用 `infra/.env` 中的 `MINIO_ROOT_USER` 与 `MINIO_ROOT_PASSWORD` 登录。Worker 当前可直接验证 `GET /health`；FastAPI 的 Swagger UI 已关闭，后续业务接口必须先实现内部密钥或用户认证再开放调试能力。

## Embedding Profile 与 API Key

P0 已固定为 `SiliconFlow / BAAI/bge-m3 / 1024 / cosine / siliconflow-bge-m3-v1`。这些非敏感配置已经写入 `infra/.env.example`；不要在创建向量表后直接改动维度或版本。题集模型调用使用账户默认的 OpenAI-compatible 连接；Tavily Key 只填写在被 Git 忽略的 `infra/.env`：

```dotenv
SILICONFLOW_API_KEY=你的密钥
```

不要把 Key 放入 `.env.example`、代码、文档截图或 Git 提交。

## 用户模型连接加密主密钥

用户可在 Web 中保存 OpenAI-compatible 的 Base URL、API Key 与模型名。API Key 不会作为 Compose 环境变量保存：Web 收到它后，使用 `CREDENTIAL_ENCRYPTION_KEY` 进行 AES-256-GCM 加密，数据库只保存密文、IV、认证标签和密钥版本；列表与创建响应均不返回 Key。

在被 Git 忽略的 `infra/.env` 生成并填写一个 Base64 编码的 32 字节随机主密钥：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

将输出填到 `CREDENTIAL_ENCRYPTION_KEY=`，并保留 `CREDENTIAL_ENCRYPTION_KEY_VERSION=local-v1`。Web 与实际调用生成模型的 Celery Worker 必须使用同一个主密钥和版本；丢失它将无法解密既有用户连接。不要将其写进 Git、浏览器、日志或 Docker 镜像。产品永久不支持用户填写 IP 字面量、localhost、局域网、私有地址或本地 vLLM；保存阶段只接受公网 HTTPS 域名/443。真实调用必须经过 Worker 的 `SafeModelEgressClient`：每次重新解析并校验全部 DNS 结果、以已验证 IP 进行 TCP/CONNECT、保留原域名 TLS SNI、拒绝重定向、限制响应体，并向 `model_connection_egress_audits` 写入不含密钥和请求正文的 30 天审计记录。

本地 `.env` 默认 `MODEL_EGRESS_ENABLED=true`（仅用于本地开发联调）；真实调用只能由 `agent-celery-worker` 使用该客户端，Web、Agent API、Dispatcher 或 Runner 不得直接调用用户 Base URL。生产环境必须按生产代理和安全策略单独配置。

## Redis 限流

Redis 使用 `infra/.env` 中的 `REDIS_PASSWORD` 启动并启用 AOF 持久化。Compose 通过 `--databases 1` 只启用 **DB 0**，Web 连接也显式选择 DB 0；不能用不同 DB 区分业务。需要可视化查看时，可在 Redis Insight 中填写 `127.0.0.1`、`REDIS_HOST_PORT`、数据库 `0` 与该密码。

业务使用稳定的键前缀隔离：`ratelimit:<策略>:<主体哈希>`（当前已实现，例如 `ratelimit:login:<sha256>`）、`session:<userId>:<tokenId>`（预留）和 `cache:<资源>:<id>`（预留）。主体仍使用 SHA-256 指纹，避免邮箱或 IP 明文出现在 Redis Insight。当前认证 Session 的权威数据仍在 PostgreSQL，尚未创建任何 `session:` Redis 键；Redis 中只保存短期限流计数，不保存用户密码、Session 原始 Token、学习业务数据或模型密钥。认证策略为：注册按 IP 每小时 3 次，登录按“邮箱 + IP”每 15 分钟 5 次；Redis 不可用时，认证接口返回 `503 AUTH_RATE_LIMIT_UNAVAILABLE`，不会退回到内存限流。

本地直连 Docker 时若没有 `X-Forwarded-For` 或 `X-Real-IP`，限流会使用共享的 `unknown` 来源指纹；本地单人开发可以接受。生产环境的反向代理必须剥离客户端伪造的这两个请求头，并写入真实客户端 IP，否则攻击者可能借伪造来源绕过按 IP 限流。

## Celery 与 PostgreSQL Outbox

`agent-dispatcher` 每秒使用 `FOR UPDATE SKIP LOCKED` 领取 `public.outbox_events` 中的 `agent.run.requested`。它将最小载荷投递到 `agent.run`，再标记 Outbox 为 `published`。若 Dispatcher 在“已发消息、未回写数据库”之间中断，事件会重新投递；`agent_run_id` 同时是 Celery `task_id`，Worker 通过 `agent.agent_runs` 的状态与事件序列处理这种至少一次投递。

Celery Worker 固定 `concurrency=1` 与 `prefetch_multiplier=1`。任务软超时为 480 秒、硬超时为 600 秒，Redis 可见性超时为 660 秒；模型请求的可恢复重试次数由 `MODEL_GATEWAY_REQUEST_MAX_RETRIES` 控制，开发示例为 5，生产 Compose 默认是 2；Celery 任务级重试由 `CELERY_TASK_MAX_RETRIES` 单独控制。每个 AgentRun 的工具调用上限由 `AGENT_TOOL_MAX_CALLS` 控制，开发默认和配置上限为 6，生产 Compose 默认是 3；Tavily 每个用户每天默认最多 20 次可见工具调用。当前四个 P0 工作流已注册，其他未支持的 `run_type` 仍会失败，不会伪造成功结果。TypeScript 侧（`agent-worker-ts`）同样已注册这四个 `run_type`，两侧通过 `AGENT_RUNTIME_ROUTES` 划分归属，同一个 AgentRun 不会被两个运行时同时领取。

可在 Redis Insight 中连接 `127.0.0.1:${CELERY_REDIS_HOST_PORT}`、数据库 `0` 并填写 `CELERY_REDIS_PASSWORD` 查看 Broker。队列内部键统一使用 `learncraft:celery:` 前缀；不要手工删除队列或未确认消息键。

## 生产 Compose

`compose.production.yaml` 是独立编排文件，只启动 Web、Agent API、Python 侧的 Dispatcher 与 Celery Worker，以及 TypeScript 侧的 `agent-dispatcher-ts` 与 `agent-worker-ts`，不创建 PostgreSQL、Redis 或 MinIO。本地开发不要启动它。

TypeScript 侧的两个服务共用 `infra/docker/agent-worker-ts.Dockerfile` 构建：`agent-worker-ts` 默认入口是 `dist/worker.js`，`agent-dispatcher-ts` 覆盖 `command` 为 `dist/dispatcher.js`。与 Python 侧一致，Worker 接入 `private` 与 `egress` 两个网络、宽限期 11 分钟；Dispatcher 只接入 `private`。除通用的 `DATABASE_URL`、`INTERNAL_SERVICE_SECRET`、`CREDENTIAL_ENCRYPTION_KEY` 外，TypeScript 侧额外要求：

- `AGENT_QUEUE_REDIS_URL`：BullMQ 连接串，必须同时被 `agent-dispatcher-ts` 与 `agent-worker-ts` 指向同一个 Redis 实例与 db；生产环境不要直接复用 Celery 的可见性超时假设。
- `AGENT_QUEUE_NAME` / `AGENT_QUEUE_PREFIX`：队列名与 Redis 键前缀，实际键名为 `<前缀>:<队列名>`，必须与 Celery 的 `learncraft:celery:` 前缀区分开。
- `AGENT_WORKER_CONCURRENCY`：BullMQ Worker 并发，按 `docs/09-全栈TypeScript迁移方案.md` 的容量分级设置，不要与 Celery 的 `CELERY_WORKER_CONCURRENCY` 混用。
- `AGENT_RUNTIME_ROUTES`：Python 与 TypeScript 两个 Dispatcher 必须读到**同一份**映射，例如 `{"assessment_generate":"ts"}`；映射为 `ts` 的 `run_type` 只由 TypeScript 领取，其余只由 Python 领取。回滚时清空该变量并重启两个 Dispatcher 即可，不需要改数据库。

部署服务器时复制统一模板 `.env.example` 为被 Git 忽略的 `.env.production`，删除或替换其中的本地默认值，填写外部 PostgreSQL、认证 Redis、Celery Redis、Provider Secret 与 `MODEL_EGRESS_PROXY_URL`，再执行：

```powershell
docker compose -f infra/compose.production.yaml --env-file infra/.env.production up --build -d
```

首版可以使用受管 Redis 或单 Redis 加备份。未来 Celery Redis 切换 Sentinel 时修改 `CELERY_BROKER_URL` 与 `CELERY_BROKER_MASTER_NAME` 即可；认证 Redis 的 Sentinel 连接器尚未实现，切换前需要单独确认并实现。生产中的 `MODEL_EGRESS_PROXY_URL` 必须是受控 HTTP CONNECT 代理；它和云防火墙均须禁止私网、云 metadata、非 443 与除 Worker 外的应用出网。Compose 的 `egress` 网络不是防火墙，不能替代这些部署侧规则。

## 持续集成

`.github/workflows/ci.yml` 在推送到 `main`、所有拉取请求与手动触发时运行四个作业，本地可用同名命令复现：

| 作业 | 覆盖内容 | 本地等价命令 |
| --- | --- | --- |
| TypeScript 工作区 | 共享安全原语与 Agent Worker 的类型检查、单元测试、esbuild 打包，Web 的类型检查、规范与测试 | `pnpm --filter <包名> typecheck\|test\|build` |
| Python Agent | ruff 规范与 pytest 单元测试 | `uv run ruff check .`、`uv run pytest -q`（在 `apps/agent-worker`） |
| 编排文件校验 | 解析 `infra/*.yaml` 并用占位值展开 `compose.production.yaml` | `docker compose -f infra/compose.yaml config --quiet` |
| 镜像构建 | 用三个生产 Dockerfile 各构建一次镜像，只构建不推送 | `docker compose -f infra/compose.production.yaml build` |

需要真实数据库、Redis 与模型服务的集成用例由环境变量开关控制，CI 中自动跳过；它们只在本地按需执行。镜像构建作业是 Dockerfile 改动的唯一自动验证手段，改动 `infra/docker/` 后请等它通过再合并。

## VS Code 查看 PostgreSQL

安装 Microsoft 的 `PostgreSQL` 扩展（`ms-ossdata.vscode-pgsql`），在其连接面板选择“Add New Connection”，填写：

```text
Host: 127.0.0.1
Port: infra/.env 中的 POSTGRES_HOST_PORT（默认 5432）
Database: infra/.env 中的 POSTGRES_DB
User: infra/.env 中的 POSTGRES_USER
Password: infra/.env 中的 POSTGRES_PASSWORD
SSL: Disable
```

连接成功后，在 `learncraft` 数据库的 `public` schema 下浏览 22 张业务/基础设施表（包含 `user_model_connections` 与 `model_connection_egress_audits`），并在 `agent` schema 下浏览 `agent_runs`、`agent_run_events`。首份 Drizzle 迁移文件位于 `apps/web/src/lib/db/migrations/0000_initial_p0_schema.sql`；新环境执行 `pnpm db:migrate` 后会创建相同结构。
