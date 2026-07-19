# LearnCraft 本地基础设施

`compose.yaml` 仅提供 P0 本地联调基线：PostgreSQL + pgvector、MinIO、Web 和 Agent Worker。它不执行 Drizzle 迁移、不创建业务表、不启动代码 Runner，也不配置真实模型 Provider。

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
| MinIO API | `http://127.0.0.1:${MINIO_API_HOST_PORT}` | S3 兼容对象存储 API。 |
| MinIO 控制台 | `http://127.0.0.1:${MINIO_CONSOLE_HOST_PORT}` | 在浏览器查看 Bucket 与对象。 |
| Agent Worker | `http://127.0.0.1:${AGENT_WORKER_HOST_PORT}` | 独立调用健康检查与后续调试接口。 |

上述端口均绑定 `127.0.0.1`，不会向局域网公开。MinIO 仅供本地 P0 使用，上线时替换为托管 S3/R2；Worker 的生产环境应移除宿主机端口映射，并通过内部网络调用。

MinIO 控制台使用 `infra/.env` 中的 `MINIO_ROOT_USER` 与 `MINIO_ROOT_PASSWORD` 登录。Worker 当前可直接验证 `GET /health`；FastAPI 的 Swagger UI 已关闭，后续业务接口必须先实现内部密钥或用户认证再开放调试能力。

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

连接成功后，在 `learncraft` 数据库的 `public` schema 下浏览表。当前尚未执行 Drizzle 迁移，因此业务表会在创建首个迁移后才出现。
