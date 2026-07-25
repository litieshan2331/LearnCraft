"""Agent Worker 运行时配置。

类：
- Settings：读取 Worker 的服务标识、已锁定的 Embedding Profile 与 Provider 密钥。

函数：
- get_settings：缓存并返回当前进程唯一的 Settings 实例。
"""

from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Worker 的服务标识与固定 Embedding Profile 配置。"""

    version: str = Field(
        default="0.1.0",
        validation_alias=AliasChoices("APP_VERSION", "LEARNCRAFT_AGENT_VERSION"),
    )
    git_sha: str = Field(
        default="unknown",
        validation_alias=AliasChoices("GIT_SHA", "LEARNCRAFT_AGENT_GIT_SHA"),
    )
    embedding_provider: Literal["SiliconFlow"] = Field(
        default="SiliconFlow",
        validation_alias="EMBEDDING_PROVIDER",
    )
    embedding_model: Literal["BAAI/bge-m3"] = Field(
        default="BAAI/bge-m3",
        validation_alias="EMBEDDING_MODEL",
    )
    embedding_dimension: int = Field(
        default=1024,
        gt=0,
        validation_alias="EMBEDDING_DIMENSION",
    )
    embedding_metric: Literal["cosine"] = Field(
        default="cosine",
        validation_alias="EMBEDDING_METRIC",
    )
    embedding_profile_version: Literal["siliconflow-bge-m3-v1"] = Field(
        default="siliconflow-bge-m3-v1",
        validation_alias="EMBEDDING_PROFILE_VERSION",
    )
    siliconflow_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="SILICONFLOW_API_KEY",
        repr=False,
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("siliconflow_api_key", mode="before")
    @classmethod
    def empty_siliconflow_api_key_to_none(cls, value: object) -> object:
        """把 Compose 注入的空 API Key 统一为未配置状态。"""
        if isinstance(value, str) and not value.strip():
            return None
        return value


@lru_cache
def get_settings() -> Settings:
    """返回缓存的 Worker 运行时配置。"""
    return Settings()
