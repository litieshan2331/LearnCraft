# 数据库适配目录

本目录承载 Web 侧唯一的 Drizzle 数据库工程：

- `client.ts`：懒加载 PostgreSQL 连接池和 Drizzle 客户端；只允许服务端代码调用。
- `schema/`：22 张 P0 表、外键、索引、CHECK 约束和关系定义的唯一 TypeScript 来源。
- `migrations/`：由 Drizzle Kit 生成的版本化 SQL；扩展、触发器等无法仅用 ORM 表达的对象以同一迁移中的 raw SQL 管理。

具体 repository 仍归属各限界上下文的 `modules/<context>/infrastructure/`，Route Handler 与 React 组件不得直接访问本目录。

## 迁移命令

在仓库根目录执行：

```powershell
# 仅根据 schema 生成迁移，不连接数据库。
pnpm db:generate

# 执行或检查迁移前，先按 infra/.env 中的 PostgreSQL 配置设置连接串。
$env:DATABASE_URL = "postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@127.0.0.1:<POSTGRES_HOST_PORT>/<POSTGRES_DB>"
pnpm db:migrate
pnpm db:check
```

Docker Compose 运行的 Web 已自动获得容器内 `DATABASE_URL`。真实密码只能从被 Git 忽略的 `infra/.env` 读取，不能写入本 README、源码或迁移文件。
