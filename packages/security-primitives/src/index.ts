/**
 * LearnCraft 安全原语的统一出口。
 *
 * 导出：
 * - credential-crypto：用户 Provider 凭据的 AES-256-GCM 加解密与配置错误类型。
 */

export {
  CredentialCryptoConfigurationError,
  decryptCredential,
  decryptCredentialWithKey,
  encryptCredential,
  type EncryptedCredential,
} from "./credential-crypto.js";
