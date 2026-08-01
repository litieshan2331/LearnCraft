/**
 * 用户 Provider 凭据的服务端加密工具。
 *
 * 导出：
 * - encryptCredential：使用环境注入的 AES-256-GCM 密钥加密 API Key。
 * - decryptCredential：在受信任服务端按相同所有者上下文解密 API Key。
 * - CredentialCryptoConfigurationError：加密主密钥未配置或不合法时的安全错误。
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
  const key = getCredentialEncryptionKey();
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
