# LearnCraft 本地基础设施

`compose.yaml` 仅提供 P0 本地联调基线：PostgreSQL + pgvector、Redis、MinIO、Web 和 Agent Worker。它不自动执行 Drizzle 迁移、不启动代码 Runner，也不调用真实模型 Provider；当前本地数据库已由手动执行的首份 Drizzle 迁移创建 22 张 P0 表。

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

日常可在 Docker Desktop 的 LearnCraft Compose 应用中直接启动、停止或重启服务。首次启动，或 Dockerfile、依赖、代码、`compose.yaml` 改动后，需要在 Docker Desktop 重新构建镜像，或执行 `docker compose up --build -d`。请勿随意删除 Compose 应用；停止服务不会移除数据库和 MinIO 的命名卷。

| 服务 | 本机地址 | 用途 |
| --- | --- | --- |
| Web | `http://127.0.0.1:${WEB_PORT}` | 浏览器访问 LearnCraft Web。 |
| PostgreSQL | `127.0.0.1:${POSTGRES_HOST_PORT}` | VS Code 数据库扩展与本机 SQL 工具。 |
| Redis | `127.0.0.1:${REDIS_HOST_PORT}` | 认证限流与本机 Redis 工具调试。 |
| MinIO API | `http://127.0.0.1:${MINIO_API_HOST_PORT}` | S3 兼容对象存储 API。 |
| MinIO 控制台 | `http://127.0.0.1:${MINIO_CONSOLE_HOST_PORT}` | 在浏览器查看 Bucket 与对象。 |
| Agent Worker | `http://127.0.0.1:${AGENT_WORKER_HOST_PORT}` | 独立调用健康检查与后续调试接口。 |

上述端口均绑定 `127.0.0.1`，不会向局域网公开。Redis 当前只用于 Web 认证限流，业务数据、Session 与 Outbox 仍存 PostgreSQL；生产环境应替换为受管 Redis、生产密码与私有网络。MinIO 仅供本地 P0 使用，上线时替换为托管 S3/R2；Worker 的生产环境应移除宿主机端口映射，并通过内部网络调用。

## 认证本地配置

`APP_ORIGIN` 是认证写接口允许的浏览器来源。本地固定为 `http://127.0.0.1:3000,http://localhost:3000`，两个地址均可分别调试；值只能是以英文逗号分隔的 Origin，不能附带路径。`SESSION_COOKIE_SECURE=false` 仅适用于本地 HTTP；部署到 HTTPS 的 staging 或 production 时，必须改为 `true`，并只填写实际部署域名。

MinIO 控制台使用 `infra/.env` 中的 `MINIO_ROOT_USER` 与 `MINIO_ROOT_PASSWORD` 登录。Worker 当前可直接验证 `GET /health`；FastAPI 的 Swagger UI 已关闭，后续业务接口必须先实现内部密钥或用户认证再开放调试能力。

## Embedding Profile 与 API Key

P0 已固定为 `SiliconFlow / BAAI/bge-m3 / 1024 / cosine / siliconflow-bge-m3-v1`。这些非敏感配置已经写入 `infra/.env.example`；不要在创建向量表后直接改动维度或版本。真实调用适配器尚未实现，届时只需在被 Git 忽略的 `infra/.env` 填写：

```dotenv
SILICONFLOW_API_KEY=你的密钥
```

不要把 Key 放入 `.env.example`、代码、文档截图或 Git 提交。

## Redis 限流

Redis 使用 `infra/.env` 中的 `REDIS_PASSWORD` 启动并启用 AOF 持久化。Compose 通过 `--databases 1` 只启用 **DB 0**，Web 连接也显式选择 DB 0；不能用不同 DB 区分业务。需要可视化查看时，可在 Redis Insight 中填写 `127.0.0.1`、`REDIS_HOST_PORT`、数据库 `0` 与该密码。

业务使用稳定的键前缀隔离：`ratelimit:<策略>:<主体哈希>`（当前已实现，例如 `ratelimit:login:<sha256>`）、`session:<userId>:<tokenId>`（预留）和 `cache:<资源>:<id>`（预留）。主体仍使用 SHA-256 指纹，避免邮箱或 IP 明文出现在 Redis Insight。当前认证 Session 的权威数据仍在 PostgreSQL，尚未创建任何 `session:` Redis 键；Redis 中只保存短期限流计数，不保存用户密码、Session 原始 Token、学习业务数据或模型密钥。认证策略为：注册按 IP 每小时 3 次，登录按“邮箱 + IP”每 15 分钟 5 次；Redis 不可用时，认证接口返回 `503 AUTH_RATE_LIMIT_UNAVAILABLE`，不会退回到内存限流。

本地直连 Docker 时若没有 `X-Forwarded-For` 或 `X-Real-IP`，限流会使用共享的 `unknown` 来源指纹；本地单人开发可以接受。生产环境的反向代理必须剥离客户端伪造的这两个请求头，并写入真实客户端 IP，否则攻击者可能借伪造来源绕过按 IP 限流。

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

连接成功后，在 `learncraft` 数据库的 `public` schema 下浏览 20 张业务/基础设施表，并在 `agent` schema 下浏览 `agent_runs`、`agent_run_events`。首份 Drizzle 迁移文件位于 `apps/web/src/lib/db/migrations/0000_initial_p0_schema.sql`；新环境执行 `pnpm db:migrate` 后会创建相同结构。
