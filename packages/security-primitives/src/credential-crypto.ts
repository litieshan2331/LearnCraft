/**
 * 用户 Provider 凭据的服务端加解密工具（Web 与 Agent Worker 共用的唯一实现）。
 *
 * 格式：AES-256-GCM；密钥来自 CREDENTIAL_ENCRYPTION_KEY（Base64 解码后必须为 32 字节）；
 * IV 12 字节随机；认证标签 16 字节；AAD 固定为 learncraft:model-connection:<ownerId>。
 *
 * 导出：
 * - EncryptedCredential：密文、IV、认证标签与密钥版本。
 * - CredentialCryptoConfigurationError：加密主密钥未配置或不合法时的安全错误。
 * - encryptCredential：加密 API Key（仅 Web 侧使用）。
 * - decryptCredential：按相同所有者上下文解密（Web 与 Worker 使用）。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const AES_256_GCM_KEY_LENGTH = 32;
const AES_GCM_IV_LENGTH = 12;

export interface EncryptedCredential {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  encryptionKeyVersion: string;
}

export class CredentialCryptoConfigurationError extends Error {
  constructor() {
    super("CREDENTIAL_ENCRYPTION_KEY 必须是 Base64 编码的 32 字节 AES-256-GCM 密钥。");
    this.name = "CredentialCryptoConfigurationError";
  }
}

export function encryptCredential(plaintext: string, ownerId: string): EncryptedCredential {
  if (!plaintext.trim()) {
    throw new Error("API Key 不能为空。");
  }

  const key = getCredentialEncryptionKey();
  const iv = randomBytes(AES_GCM_IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(getOwnerContext(ownerId));

  return {
    ciphertext: Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]),
    iv,
    authTag: cipher.getAuthTag(),
    encryptionKeyVersion: process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION?.trim() || "v1",
  };
}

export function decryptCredential(encrypted: EncryptedCredential, ownerId: string): string {
  return decryptCredentialWithKey(encrypted, ownerId, getCredentialEncryptionKey());
}

/**
 * 使用调用方提供的 32 字节密钥解密。
 * 供需要自行校验密钥来源与版本的调用方（例如 Agent Worker）复用同一份格式实现，避免格式漂移。
 */
export function decryptCredentialWithKey(
  encrypted: EncryptedCredential,
  ownerId: string,
  key: Buffer,
): string {
  if (key.length !== AES_256_GCM_KEY_LENGTH) {
    throw new CredentialCryptoConfigurationError();
  }

  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.iv);
  decipher.setAAD(getOwnerContext(ownerId));
  decipher.setAuthTag(encrypted.authTag);

  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
}

function getCredentialEncryptionKey(): Buffer {
  const encodedKey = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!encodedKey) {
    throw new CredentialCryptoConfigurationError();
  }

  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== AES_256_GCM_KEY_LENGTH) {
    throw new CredentialCryptoConfigurationError();
  }

  return key;
}

function getOwnerContext(ownerId: string): Buffer {
  return Buffer.from(`learncraft:model-connection:${ownerId}`, "utf8");
}
