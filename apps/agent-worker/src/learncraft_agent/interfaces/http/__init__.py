"""FastAPI HTTP 接口边界。

本包提供仅内网可达的健康检查，并为后续内部 AgentRun 接口保留边界。

公开浏览器 API 仍由 Next.js Web 提供；内部 AgentRun 接口将在后续步骤添加。
"""
