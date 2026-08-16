"""用户模型凭据的 Worker 端 AES-256-GCM 解密器。

类：
- EncryptedModelCredential：Web 内部接口传来的 Base64 密文载荷。
- CredentialDecryptionError：不泄露密文或密钥的稳定解密错误。
- ModelCredentialDecryptor：使用 owner AAD 解密 API Key。
"""

from __future__ import annotations

from base64 import b64decode
from binascii import Error as BinasciiError
from uuid import UUID

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import BaseModel, ConfigDict, Field, SecretStr


class EncryptedModelCredential(BaseModel):
    """表示与 Node.js AES-256-GCM 加密格式兼容的 Base64 密文。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    ciphertext_base64: str = Field(min_length=1)
    iv_base64: str = Field(min_length=1)
    auth_tag_base64: str = Field(min_length=1)
    encryption_key_version: str = Field(min_length=1, max_length=50)


class CredentialDecryptionError(RuntimeError):
    """表示当前 Worker 无法安全使用已保存模型凭据的错误。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ModelCredentialDecryptor:
    """以与 Web 相同的 owner AAD 解密用户模型 API Key。"""

    def __init__(self, *, encryption_key: SecretStr | None, key_version: str) -> None:
        self._encryption_key = encryption_key
        self._key_version = key_version

    def decrypt(self, *, owner_id: UUID, credential: EncryptedModelCredential) -> SecretStr:
        """验证版本和编码后，在内存中返回 API Key，绝不记录明文。"""
        if self._encryption_key is None:
            raise CredentialDecryptionError(
                "CREDENTIAL_ENCRYPTION_UNAVAILABLE",
                "模型凭据解密主密钥尚未配置。",
            )
        if credential.encryption_key_version != self._key_version:
            raise CredentialDecryptionError(
                "CREDENTIAL_ENCRYPTION_KEY_VERSION_UNSUPPORTED",
                "模型凭据使用了当前 Worker 不支持的密钥版本。",
            )

        key = self._decode_base64(
            self._encryption_key.get_secret_value(),
            "CREDENTIAL_ENCRYPTION_KEY_INVALID",
        )
        if len(key) != 32:
            raise CredentialDecryptionError(
                "CREDENTIAL_ENCRYPTION_KEY_INVALID",
                "模型凭据解密主密钥格式不正确。",
            )

        ciphertext = self._decode_base64(
            credential.ciphertext_base64,
            "MODEL_CREDENTIAL_ENCODING_INVALID",
        )
        iv = self._decode_base64(credential.iv_base64, "MODEL_CREDENTIAL_ENCODING_INVALID")
        auth_tag = self._decode_base64(
            credential.auth_tag_base64,
            "MODEL_CREDENTIAL_ENCODING_INVALID",
        )
        if len(iv) != 12 or len(auth_tag) != 16:
            raise CredentialDecryptionError(
                "MODEL_CREDENTIAL_ENCODING_INVALID",
                "模型凭据加密参数格式不正确。",
            )

        try:
            plaintext = AESGCM(key).decrypt(
                iv,
                ciphertext + auth_tag,
                f"learncraft:model-connection:{owner_id}".encode("utf-8"),
            )
        except InvalidTag as error:
            raise CredentialDecryptionError(
                "MODEL_CREDENTIAL_DECRYPTION_FAILED",
                "模型凭据无法通过完整性校验。",
            ) from error

        api_key = plaintext.decode("utf-8").strip()
        if not api_key:
            raise CredentialDecryptionError(
                "MODEL_CREDENTIAL_DECRYPTION_FAILED",
                "模型凭据解密后为空。",
            )
        return SecretStr(api_key)

    @staticmethod
    def _decode_base64(value: str, error_code: str) -> bytes:
        """严格解码 Base64，避免宽松解析损坏的凭据载荷。"""
        try:
            return b64decode(value, validate=True)
        except (BinasciiError, ValueError) as error:
            raise CredentialDecryptionError(error_code, "模型凭据编码不正确。") from error

