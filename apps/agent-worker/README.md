# LearnCraft Agent Worker

`learncraft-agent` 是 LearnCraft 的 Python Agent Worker，使用 FastAPI、LangGraph、SQLAlchemy 和 Pydantic。它负责 Agent 编排、模型调用、受控检索、Demo 验证和内部服务通信；不持有用户、学习目标、路线或题目等核心业务写模型。

当前已实现仅内网使用的 `GET /health`。它验证 Worker 进程与基础运行时配置；数据库连接与真实模型 Provider 尚未接入。

## 本地命令

在本目录执行：

```powershell
# 校验 Python 代码风格
uv run ruff check src

# 启动 Worker，默认监听 http://127.0.0.1:8000
uv run learncraft-agent
```

## 数据库边界

P0 的所有数据库迁移均由 Web 侧 Drizzle 维护。Python SQLAlchemy 未来仅映射 `agent.agent_runs` 与 `agent.agent_run_events`，且 Worker 对学习目标、路线、测验和内容的写入必须经过 Web 的内部 API。
