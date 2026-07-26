"""Agent Worker 的 SQLAlchemy 异步数据库连接工厂。

函数：
- normalize_async_database_url：将通用 PostgreSQL URL 转换为 asyncpg 方言 URL。
- create_session_factory：基于队列配置创建 Agent 只读/运行状态专用的会话工厂。
"""

from functools import lru_cache

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from learncraft_agent.core.config import get_queue_settings


def normalize_async_database_url(database_url: str) -> str:
    """将 Web 与 Python 共用的 PostgreSQL URL 标准化为 SQLAlchemy asyncpg URL。"""
    if database_url.startswith("postgresql+asyncpg://"):
        return database_url
    if database_url.startswith("postgresql://"):
        return database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if database_url.startswith("postgres://"):
        return database_url.replace("postgres://", "postgresql+asyncpg://", 1)
    raise ValueError("DATABASE_URL 必须是 PostgreSQL 连接串。")


@lru_cache
def create_session_factory() -> async_sessionmaker[AsyncSession]:
    """创建供 Dispatcher 与 AgentRun Repository 使用的独立异步会话工厂。"""
    settings = get_queue_settings()
    engine = create_async_engine(
        normalize_async_database_url(settings.database_url),
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=2,
    )
    return async_sessionmaker(engine, expire_on_commit=False)
