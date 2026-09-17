/**
 * 用户 Provider 凭据加解密的单元测试。
 *
 * 测试：
 * - encryptCredential / decryptCredential：API Key 可回读，且不能由其他所有者上下文解密。
 * - CredentialCryptoConfigurationError：未配置或非法主密钥时安全失败。
 * - 格式契约：IV 12 字节、认证标签 16 字节、AAD 与密钥版本取自环境变量。
 * - 跨语言向量：Python 侧（cryptography.AESGCM）加密的密文必须能被本实现解密。
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  CredentialCryptoConfigurationError,
  decryptCredential,
  encryptCredential,
} from "../src/credential-crypto.js";

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

  it("拒绝由其他所有者上下文解密", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    const encrypted = encryptCredential("sk-example-secret", "owner-a");

    expect(() => decryptCredential(encrypted, "owner-b")).toThrow();
  });

  it("未配置 32 字节主密钥时安全失败", () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;

    expect(() => encryptCredential("sk-example-secret", "owner-a")).toThrow(
      CredentialCryptoConfigurationError,
    );
  });

  it("遵循格式契约：12 字节 IV、16 字节认证标签、默认密钥版本 v1", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION;

    const encrypted = encryptCredential("sk-example-secret", "owner-a");

    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.encryptionKeyVersion).toBe("v1");
  });
});

describe("跨语言互操作（Python cryptography.AESGCM → TypeScript）", () => {
  // 向量由 Python 生成，参数与 apps/agent-worker 的 ModelCredentialDecryptor 完全一致：
  // key=bytes([7])*32、iv=bytes([9])*12、AAD=learncraft:model-connection:<owner>，标签单独存储。
  const pythonVector = {
    ownerId: "11111111-2222-3333-4444-555555555555",
    keyBase64: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    ivBase64: "CQkJCQkJCQkJCQkJ",
    ciphertextBase64: "VO6p5MeEqQ7OT6JWko/RsKSdFZZXmpiyQp52luQ=",
    authTagBase64: "wjFGYrR1BSgWJn18ZItV/g==",
    plaintext: "sk-python-interop-vector-0001",
  };

  it("能够解密 Python 侧生成的密文", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = pythonVector.keyBase64;

    const plaintext = decryptCredential(
      {
        ciphertext: Buffer.from(pythonVector.ciphertextBase64, "base64"),
        iv: Buffer.from(pythonVector.ivBase64, "base64"),
        authTag: Buffer.from(pythonVector.authTagBase64, "base64"),
        encryptionKeyVersion: "local-v1",
      },
      pythonVector.ownerId,
    );

    expect(plaintext).toBe(pythonVector.plaintext);
  });

  it("所有者不匹配时认证失败", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = pythonVector.keyBase64;

    expect(() =>
      decryptCredential(
        {
          ciphertext: Buffer.from(pythonVector.ciphertextBase64, "base64"),
          iv: Buffer.from(pythonVector.ivBase64, "base64"),
          authTag: Buffer.from(pythonVector.authTagBase64, "base64"),
          encryptionKeyVersion: "local-v1",
        },
        "99999999-2222-3333-4444-555555555555",
      ),
    ).toThrow();
  });
});
