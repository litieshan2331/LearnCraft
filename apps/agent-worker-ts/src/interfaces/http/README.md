# interfaces/http：健康与就绪端点

本目录提供 TypeScript Agent 服务对外的最小 HTTP 面，替代 Python 侧 `agent-api` 仅剩的健康检查职责。

文件：

- `health-server.ts`：`startHealthServer` —— 用 `node:http` 起的极简服务，暴露两个只读端点：
  - `GET /health`：存活探测，字段与 Python 的 `ServiceStatusResponse` 同形
    （`status` / `service` / `version` / `git_sha`），并并入各进程的运行时细节
    （已注册工作流、队列名与前缀、Tavily 是否配置等，不含任何密钥）。
  - `GET /ready`：就绪探测，执行调用方注入的依赖检查（数据库 `SELECT 1` 与队列 Redis `PING`），
    任一失败返回 503。供 compose healthcheck 与运维在 Python 下线后判断 Agent 侧是否可用。
  - 其余路径 404、非 GET 405；`port` 传 0 时由系统分配（测试用）。

约定：

- 只做只读探测，不暴露业务接口，因此不需要鉴权，也不应返回任何密钥或连接串。
- 默认监听 `AGENT_HTTP_PORT`（缺省 8080）与 `AGENT_HTTP_HOST`（缺省 `0.0.0.0`）；
  两个容器各自监听同一端口，互不冲突。
- `close()` 会等待连接释放，进程入口在优雅关闭流程中调用它。
