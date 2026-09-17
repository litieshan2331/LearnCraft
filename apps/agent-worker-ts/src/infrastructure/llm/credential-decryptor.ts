/**
 * 用户 Provider 凭据解密（等价于 Python 的 ModelCredentialDecryptor）。
 *
 * 职责：把 Web 内部接口返回的 Base64 凭据信封解密为明文 API Key，并保持与 Python 相同的错误码。
 * 加密算法与 AAD 由共享包 @learncraft/security-primitives 统一实现，本文件只负责：
 * 校验密钥是否配置、密钥版本是否匹配、Base64 是否严格合法、IV/标签长度是否正确。
 *
 * 导出：
 * - EncryptedModelCredentialEnvelope：内部接口返回的 snake_case 凭据信封。
 * - CredentialDecryptionError：带稳定错误码的解密异常。
 * - ModelCredentialDecryptor：decrypt 与 fromEnvironment。
 */

import {
  CredentialCryptoConfigurationError,
  decryptCredentialWithKey,
} from "@learncraft/security-primitives";

export const CREDENTIAL_ENCRYPTION_UNAVAILABLE = "CREDENTIAL_ENCRYPTION_UNAVAILABLE";
export const CREDENTIAL_ENCRYPTION_KEY_VERSION_UNSUPPORTED = "CREDENTIAL_ENCRYPTION_KEY_VERSION_UNSUPPORTED";
export const CREDENTIAL_ENCRYPTION_KEY_INVALID = "CREDENTIAL_ENCRYPTION_KEY_INVALID";
export const MODEL_CREDENTIAL_ENCODING_INVALID = "MODEL_CREDENTIAL_ENCODING_INVALID";
export const MODEL_CREDENTIAL_DECRYPTION_FAILED = "MODEL_CREDENTIAL_DECRYPTION_FAILED";

const AES_256_GCM_KEY_LENGTH = 32;
const AES_GCM_IV_LENGTH = 12;
const AES_GCM_AUTH_TAG_LENGTH = 16;

export interface EncryptedModelCredentialEnvelope {
  ciphertext_base64: string;
  iv_base64: string;
  auth_tag_base64: string;
  encryption_key_version: string;
}

export class CredentialDecryptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CredentialDecryptionError";
  }
}

/**
 * 严格 Base64 解码。
 * Node 的 Buffer.from(x, 'base64') 会静默忽略非法字符，与 Python 的 b64decode(validate=True) 不等价，
 * 因此这里先做字符集与长度校验，再用重新编码的结果做一次往返比对。
 */
function decodeBase64Strict(value: string, errorCode: string): Buffer {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new CredentialDecryptionError(errorCode, "凭据字段不是合法的 Base64。");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new CredentialDecryptionError(errorCode, "凭据字段不是合法的 Base64。");
  }
  return decoded;
}

export class ModelCredentialDecryptor {
  constructor(
    private readonly encryptionKeyBase64: string | null,
    private readonly keyVersion: string,
  ) {}

  /** 从环境变量构造：CREDENTIAL_ENCRYPTION_KEY 与 CREDENTIAL_ENCRYPTION_KEY_VERSION。 */
  static fromEnvironment(): ModelCredentialDecryptor {
    const rawKey = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
    const version = process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION?.trim() || "v1";
    return new ModelCredentialDecryptor(rawKey === undefined || rawKey.length === 0 ? null : rawKey, version);
  }

  /** 解密凭据信封；任何失败都以稳定错误码抛出，绝不回显明文或密文。 */
  decrypt(ownerId: string, credential: EncryptedModelCredentialEnvelope): string {
    if (this.encryptionKeyBase64 === null) {
      throw new CredentialDecryptionError(CREDENTIAL_ENCRYPTION_UNAVAILABLE, "未配置凭据加密主密钥。");
    }
    if (credential.encryption_key_version !== this.keyVersion) {
      throw new CredentialDecryptionError(
        CREDENTIAL_ENCRYPTION_KEY_VERSION_UNSUPPORTED,
        "凭据的加密密钥版本与当前配置不一致。",
      );
    }

    const key = decodeBase64Strict(this.encryptionKeyBase64, CREDENTIAL_ENCRYPTION_KEY_INVALID);
    if (key.length !== AES_256_GCM_KEY_LENGTH) {
      throw new CredentialDecryptionError(CREDENTIAL_ENCRYPTION_KEY_INVALID, "凭据加密主密钥长度不是 32 字节。");
    }

    const ciphertext = decodeBase64Strict(credential.ciphertext_base64, MODEL_CREDENTIAL_ENCODING_INVALID);
    const iv = decodeBase64Strict(credential.iv_base64, MODEL_CREDENTIAL_ENCODING_INVALID);
    const authTag = decodeBase64Strict(credential.auth_tag_base64, MODEL_CREDENTIAL_ENCODING_INVALID);
    if (iv.length !== AES_GCM_IV_LENGTH || authTag.length !== AES_GCM_AUTH_TAG_LENGTH) {
      throw new CredentialDecryptionError(
        MODEL_CREDENTIAL_ENCODING_INVALID,
        "凭据的 IV 或认证标签长度不合法。",
      );
    }

    let plaintext: string;
    try {
      plaintext = decryptCredentialWithKey(
        { ciphertext, iv, authTag, encryptionKeyVersion: credential.encryption_key_version },
        ownerId,
        key,
      );
    } catch (error) {
      // 认证失败、所有者不匹配、密钥不合法都统一归为解密失败，避免泄露区分信息。
      if (error instanceof CredentialCryptoConfigurationError) {
        throw new CredentialDecryptionError(CREDENTIAL_ENCRYPTION_KEY_INVALID, "凭据加密主密钥不合法。");
      }
      throw new CredentialDecryptionError(MODEL_CREDENTIAL_DECRYPTION_FAILED, "凭据解密失败。");
    }

    const trimmed = plaintext.trim();
    if (trimmed.length === 0) {
      throw new CredentialDecryptionError(MODEL_CREDENTIAL_DECRYPTION_FAILED, "凭据解密结果为空。");
    }
    return trimmed;
  }
}
