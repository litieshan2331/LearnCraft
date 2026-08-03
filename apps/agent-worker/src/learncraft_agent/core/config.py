"""Agent Worker 运行时配置。

类：
- Settings：读取 Agent API 的服务标识、已锁定的 Embedding Profile、Provider 密钥、用户凭据加密与模型受控出网配置。
- QueueSettings：读取 Dispatcher 与 Celery Worker 的 PostgreSQL、Broker、超时和重试配置。

函数：
- get_settings：缓存并返回当前进程唯一的 Settings 实例。
- get_queue_settings：缓存并返回 Dispatcher/Celery 专用的 QueueSettings 实例。
"""

from functools import lru_cache
from typing import Literal
from urllib.parse import urlsplit

from pydantic import AliasChoices, Field, SecretStr, field_validator, model_validator
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
    credential_encryption_key: SecretStr | None = Field(
        default=None,
        validation_alias="CREDENTIAL_ENCRYPTION_KEY",
        repr=False,
    )
    credential_encryption_key_version: str = Field(
        default="v1",
        validation_alias="CREDENTIAL_ENCRYPTION_KEY_VERSION",
    )
    model_egress_enabled: bool = Field(
        default=False,
        validation_alias="MODEL_EGRESS_ENABLED",
    )
    model_egress_environment: Literal["development", "production"] = Field(
        default="development",
        validation_alias="MODEL_EGRESS_ENVIRONMENT",
    )
    model_egress_proxy_url: str | None = Field(
        default=None,
        validation_alias="MODEL_EGRESS_PROXY_URL",
    )
    model_egress_connect_timeout_seconds: float = Field(
        default=10.0,
        gt=0,
        le=60,
        validation_alias="MODEL_EGRESS_CONNECT_TIMEOUT_SECONDS",
    )
    model_egress_read_timeout_seconds: float = Field(
        default=120.0,
        gt=0,
        le=600,
        validation_alias="MODEL_EGRESS_READ_TIMEOUT_SECONDS",
    )
    model_egress_max_response_bytes: int = Field(
        default=4 * 1024 * 1024,
        ge=1024,
        le=16 * 1024 * 1024,
        validation_alias="MODEL_EGRESS_MAX_RESPONSE_BYTES",
    )
    model_egress_audit_retention_days: int = Field(
        default=30,
        ge=1,
        le=365,
        validation_alias="MODEL_EGRESS_AUDIT_RETENTION_DAYS",
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("siliconflow_api_key", "credential_encryption_key", mode="before")
    @classmethod
    def empty_secret_to_none(cls, value: object) -> object:
        """把 Compose 注入的空密钥统一为未配置状态。"""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("model_egress_proxy_url", mode="before")
    @classmethod
    def empty_proxy_url_to_none(cls, value: object) -> object:
        """把未配置的受控出网代理地址统一为 None。"""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @model_validator(mode="after")
    def validate_model_egress_settings(self) -> "Settings":
        """确保生产环境启用模型出网时只能经显式配置的代理。"""
        if not self.model_egress_proxy_url:
            if self.model_egress_environment == "production" and self.model_egress_enabled:
                raise ValueError(
                    "生产环境启用模型出网时必须配置 MODEL_EGRESS_PROXY_URL。",
                )
            return self

        parsed_proxy_url = urlsplit(self.model_egress_proxy_url)
        if (
            parsed_proxy_url.scheme not in {"http", "https"}
            or not parsed_proxy_url.hostname
            or parsed_proxy_url.username
            or parsed_proxy_url.password
            or parsed_proxy_url.query
            or parsed_proxy_url.fragment
        ):
            raise ValueError("MODEL_EGRESS_PROXY_URL 必须是不含认证信息、查询参数或片段的 HTTP(S) 地址。")
        return self


class QueueSettings(BaseSettings):
    """Celery、PostgreSQL Outbox 与 AgentRun 执行所需的运行时配置。"""

    database_url: str = Field(validation_alias="DATABASE_URL")
    celery_broker_url: str = Field(validation_alias="CELERY_BROKER_URL")
    celery_broker_master_name: str | None = Field(
        default=None,
        validation_alias="CELERY_BROKER_MASTER_NAME",
    )
    celery_queue_name: str = Field(
        default="agent.run",
        validation_alias="CELERY_QUEUE_NAME",
    )
    celery_redis_key_prefix: str = Field(
        default="learncraft:celery:",
        validation_alias="CELERY_REDIS_KEY_PREFIX",
    )
    celery_visibility_timeout_seconds: int = Field(
        default=660,
        ge=60,
        validation_alias="CELERY_VISIBILITY_TIMEOUT_SECONDS",
    )
    celery_task_soft_time_limit_seconds: int = Field(
        default=480,
        ge=1,
        validation_alias="CELERY_TASK_SOFT_TIME_LIMIT_SECONDS",
    )
    celery_task_time_limit_seconds: int = Field(
        default=600,
        ge=1,
        validation_alias="CELERY_TASK_TIME_LIMIT_SECONDS",
    )
    celery_task_max_retries: int = Field(
        default=3,
        ge=0,
        validation_alias="CELERY_TASK_MAX_RETRIES",
    )
    celery_retry_backoff_seconds: int = Field(
        default=10,
        ge=1,
        validation_alias="CELERY_RETRY_BACKOFF_SECONDS",
    )
    celery_retry_backoff_max_seconds: int = Field(
        default=300,
        ge=1,
        validation_alias="CELERY_RETRY_BACKOFF_MAX_SECONDS",
    )
    celery_worker_concurrency: int = Field(
        default=1,
        ge=1,
        validation_alias="CELERY_WORKER_CONCURRENCY",
    )
    outbox_dispatcher_id: str = Field(
        default="agent-dispatcher",
        min_length=1,
        max_length=100,
        validation_alias="OUTBOX_DISPATCHER_ID",
    )
    outbox_poll_interval_seconds: float = Field(
        default=1.0,
        gt=0,
        le=60,
        validation_alias="OUTBOX_POLL_INTERVAL_SECONDS",
    )
    outbox_batch_size: int = Field(
        default=20,
        ge=1,
        le=100,
        validation_alias="OUTBOX_BATCH_SIZE",
    )
    outbox_lock_timeout_seconds: int = Field(
        default=900,
        ge=60,
        validation_alias="OUTBOX_LOCK_TIMEOUT_SECONDS",
    )
    outbox_max_attempts: int = Field(
        default=10,
        ge=1,
        validation_alias="OUTBOX_MAX_ATTEMPTS",
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("celery_broker_master_name", mode="before")
    @classmethod
    def empty_broker_master_name_to_none(cls, value: object) -> object:
        """将未配置的 Sentinel 主库名称统一为 None。"""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @model_validator(mode="after")
    def validate_queue_time_limits(self) -> "QueueSettings":
        """确保软超时、硬超时与 Redis 可见性超时能安全配合。"""
        if self.celery_task_soft_time_limit_seconds >= self.celery_task_time_limit_seconds:
            raise ValueError("CELERY_TASK_SOFT_TIME_LIMIT_SECONDS 必须小于硬超时。")
        if self.celery_visibility_timeout_seconds <= self.celery_task_time_limit_seconds:
            raise ValueError("CELERY_VISIBILITY_TIMEOUT_SECONDS 必须大于任务硬超时。")
        if self.celery_broker_url.startswith("sentinel://") and not self.celery_broker_master_name:
            raise ValueError("Sentinel Broker 必须配置 CELERY_BROKER_MASTER_NAME。")
        return self


@lru_cache
def get_settings() -> Settings:
    """返回缓存的 Worker 运行时配置。"""
    return Settings()


@lru_cache
def get_queue_settings() -> QueueSettings:
    """返回仅供 Dispatcher 与 Celery Worker 使用的队列配置。"""
    return QueueSettings()
