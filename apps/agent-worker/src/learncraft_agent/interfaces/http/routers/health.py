"""Agent Worker 内网健康检查路由。

函数：
- get_health：返回 Worker 进程与基础运行时的健康状态；数据库就绪检查将在基础设施接入后补充。
"""

from fastapi import APIRouter

from learncraft_agent.core.config import get_settings
from learncraft_agent.interfaces.http.schemas.system import ServiceStatusResponse

router = APIRouter(tags=["system"])


@router.get("/health", response_model=ServiceStatusResponse, include_in_schema=False)
def get_health() -> ServiceStatusResponse:
    """返回 Agent Worker 的基础健康状态。"""
    settings = get_settings()
    return ServiceStatusResponse(version=settings.version, git_sha=settings.git_sha)
