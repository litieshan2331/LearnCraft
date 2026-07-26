"""Agent Worker 配置测试。

本文件验证已批准的 SiliconFlow BGE-M3 Embedding Profile 默认值，以及空 API Key
不会被误认为已配置的密钥。
"""

import pytest
from pydantic import ValidationError

from learncraft_agent.core.config import QueueSettings, Settings


def test_settings_uses_the_approved_embedding_profile() -> None:
    """确保未注入环境变量时仍使用唯一批准的 P0 Profile。"""
    settings = Settings(_env_file=None)

    assert settings.embedding_provider == "SiliconFlow"
    assert settings.embedding_model == "BAAI/bge-m3"
    assert settings.embedding_dimension == 1024
    assert settings.embedding_metric == "cosine"
    assert settings.embedding_profile_version == "siliconflow-bge-m3-v1"


def test_settings_treats_a_blank_api_key_as_missing() -> None:
    """确保 Compose 的空环境变量不会伪装成可调用 Provider 的密钥。"""
    settings = Settings(_env_file=None, SILICONFLOW_API_KEY="  ")

    assert settings.siliconflow_api_key is None


def test_queue_settings_use_the_confirmed_celery_defaults() -> None:
    """确保 P0 的单并发、超时和重试策略由配置模型固定。"""
    settings = QueueSettings(
        _env_file=None,
        DATABASE_URL="postgresql://learncraft:password@postgres:5432/learncraft",
        CELERY_BROKER_URL="redis://:password@celery-redis:6379/0",
    )

    assert settings.celery_queue_name == "agent.run"
    assert settings.celery_worker_concurrency == 1
    assert settings.celery_task_soft_time_limit_seconds == 480
    assert settings.celery_task_time_limit_seconds == 600
    assert settings.celery_visibility_timeout_seconds == 660
    assert settings.celery_task_max_retries == 3


def test_queue_settings_require_master_name_for_sentinel() -> None:
    """确保未来切换 Sentinel 时不会因遗漏主库名称而静默启动。"""
    with pytest.raises(ValidationError, match="CELERY_BROKER_MASTER_NAME"):
        QueueSettings(
            _env_file=None,
            DATABASE_URL="postgresql://learncraft:password@postgres:5432/learncraft",
            CELERY_BROKER_URL="sentinel://sentinel-1:26379;sentinel://sentinel-2:26379/0",
        )
