/**
 * 用户 Provider 凭据加解密（Web 侧入口）。
 *
 * 实现已抽取到共享包 @learncraft/security-primitives，使 Web 与 Agent Worker 共用唯一一份实现；
 * 本文件只做转出，保持既有导入路径与函数签名不变。
 *
 * 导出：
 * - EncryptedCredential：密文、IV、认证标签与密钥版本。
 * - CredentialCryptoConfigurationError：加密主密钥未配置或不合法时的安全错误。
 * - encryptCredential / decryptCredential：加密与解密。
 */

export {
  CredentialCryptoConfigurationError,
  decryptCredential,
  encryptCredential,
  type EncryptedCredential,
} from "@learncraft/security-primitives";
