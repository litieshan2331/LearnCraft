"""Agent Worker 配置测试。

本文件验证已批准的 SiliconFlow BGE-M3 Embedding Profile 默认值，以及空 API Key
不会被误认为已配置的密钥。
"""

from learncraft_agent.core.config import Settings


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
