"""Agent Worker 运行时配置。

类：
- Settings：读取 Worker 的安全运行时标识，不承载模型密钥或业务规则。

函数：
- get_settings：缓存并返回当前进程唯一的 Settings 实例。
"""

from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Worker 的非敏感基础运行时配置。"""

    version: str = Field(
        default="0.1.0",
        validation_alias=AliasChoices("APP_VERSION", "LEARNCRAFT_AGENT_VERSION"),
    )
    git_sha: str = Field(
        default="unknown",
        validation_alias=AliasChoices("GIT_SHA", "LEARNCRAFT_AGENT_GIT_SHA"),
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    """返回缓存的 Worker 运行时配置。"""
    return Settings()
