/**
 * 用户 Provider 凭据加密工具的单元测试。
 *
 * 测试：
 * - encryptCredential / decryptCredential：验证 API Key 可回读，且不能由其他用户上下文解密。
 * - CredentialCryptoConfigurationError：验证未配置或非法主密钥会安全失败。
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  CredentialCryptoConfigurationError,
  decryptCredential,
  encryptCredential,
} from "./credential-crypto";

const previousKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
const previousKeyVersion = process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION;

afterEach(() => {
  if (previousKey === undefined) {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  } else {
    process.env.CREDENTIAL_ENCRYPTION_KEY = previousKey;
  }

  if (previousKeyVersion === undefined) {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION;
  } else {
    process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = previousKeyVersion;
  }
});

describe("用户 Provider 凭据加密", () => {
  it("以所有者上下文加密并回读 API Key", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "local-v1";

    const encrypted = encryptCredential("sk-example-secret", "owner-a");

    expect(encrypted.ciphertext.equals(Buffer.from("sk-example-secret"))).toBe(false);
    expect(encrypted.encryptionKeyVersion).toBe("local-v1");
    expect(decryptCredential(encrypted, "owner-a")).toBe("sk-example-secret");
  });

  it("拒绝由其他用户上下文解密", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    const encrypted = encryptCredential("sk-example-secret", "owner-a");

    expect(() => decryptCredential(encrypted, "owner-b")).toThrow();
  });

  it("未配置 32 字节主密钥时安全失败", () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;

    expect(() => encryptCredential("sk-example-secret", "owner-a"))
      .toThrow(CredentialCryptoConfigurationError);
  });
});
