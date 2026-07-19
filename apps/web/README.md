# LearnCraft Web

`@learncraft/web` 是 LearnCraft 的 Web 应用。它基于 Next.js App Router 构建，后续会承载学习者界面，以及面向浏览器的 BFF/Core API。

当前目录已建立 DDD 目录骨架，但仍保留 Next.js 的最小页面；认证、学习目标、路线和 Agent 调用等业务功能尚未开始实现。

## 开发环境

- Node.js：`>= 20.9.0`
- pnpm：`>= 11.15.0`，通过 Corepack 管理

请先在仓库根目录安装依赖：

```powershell
pnpm install --frozen-lockfile
```

## 常用命令

以下命令均在仓库根目录执行：

```powershell
# 启动本地开发服务器，默认访问 http://localhost:3000
pnpm dev:web

# 执行生产构建
pnpm build:web

# 执行 ESLint 检查
pnpm lint:web

# 执行 TypeScript 类型检查
pnpm typecheck:web
```

也可以只在本应用目录中执行：

```powershell
pnpm --filter @learncraft/web dev
```

## 当前目录说明

```text
apps/web/
├─ public/                 # 静态资源
├─ src/
│  ├─ app/                 # Next.js 页面、布局与薄 Route Handler
│  ├─ modules/             # 按限界上下文组织的 DDD 四层模块
│  └─ lib/                 # 数据库、Session、Outbox、日志等框架适配
├─ tests/                  # 单元、集成与端到端测试
├─ package.json            # Web 应用依赖与脚本
├─ tsconfig.json           # TypeScript 配置
└─ next.config.ts          # Next.js 配置
```

## 依赖安装约定

依赖统一由仓库根目录的 pnpm 工作区管理。新增依赖后应提交 `pnpm-lock.yaml`；`node_modules`、`.next` 和 TypeScript 构建缓存均为本地生成文件，不应提交到 Git。
