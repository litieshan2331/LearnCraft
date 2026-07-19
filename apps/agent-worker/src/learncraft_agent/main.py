"""Agent Worker 的 FastAPI 应用与命令行入口。

函数：
- create_app：创建并配置仅供私有网络访问的 FastAPI 应用。
- main：使用 Uvicorn 启动 Worker HTTP 服务。
"""

import uvicorn
from fastapi import FastAPI

from learncraft_agent.core.config import get_settings
from learncraft_agent.interfaces.http.routers.health import router as health_router


def create_app() -> FastAPI:
    """创建包含内网健康检查路由的 FastAPI 应用。"""
    settings = get_settings()
    app = FastAPI(
        title="LearnCraft Agent Worker",
        version=settings.version,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.include_router(health_router)
    return app


app = create_app()


def main() -> None:
    """通过 Uvicorn 在默认 Worker 端口启动 FastAPI 应用。"""
    uvicorn.run("learncraft_agent.main:app", host="0.0.0.0", port=8000)
