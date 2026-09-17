/**
 * 凭据解密测试：验证内部接口返回的 Base64 信封能被正确解密，且错误码与 Python 实现一致。
 *
 * 其中“跨语言向量”用例使用 Python（cryptography.AESGCM）生成的密文，验证两种运行时对同一格式的理解一致。
 */
import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_ENCRYPTION_KEY_INVALID,
  CREDENTIAL_ENCRYPTION_KEY_VERSION_UNSUPPORTED,
  CREDENTIAL_ENCRYPTION_UNAVAILABLE,
  CredentialDecryptionError,
  MODEL_CREDENTIAL_DECRYPTION_FAILED,
  MODEL_CREDENTIAL_ENCODING_INVALID,
  ModelCredentialDecryptor,
  type EncryptedModelCredentialEnvelope,
} from '../src/infrastructure/llm/credential-decryptor.js';

const KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');

// 由 Python 生成：key=bytes([7])*32、iv=bytes([9])*12、AAD=learncraft:model-connection:<owner>。
const PYTHON_VECTOR_ENVELOPE: EncryptedModelCredentialEnvelope = {
  ciphertext_base64: 'VO6p5MeEqQ7OT6JWko/RsKSdFZZXmpiyQp52luQ=',
  iv_base64: 'CQkJCQkJCQkJCQkJ',
  auth_tag_base64: 'wjFGYrR1BSgWJn18ZItV/g==',
  encryption_key_version: 'local-v1',
};
const PYTHON_VECTOR_OWNER = '11111111-2222-3333-4444-555555555555';

describe('ModelCredentialDecryptor', () => {
  it('解密 Python 侧生成的凭据信封', () => {
    const decryptor = new ModelCredentialDecryptor(KEY_BASE64, 'local-v1');
    expect(decryptor.decrypt(PYTHON_VECTOR_OWNER, PYTHON_VECTOR_ENVELOPE)).toBe(
      'sk-python-interop-vector-0001',
    );
  });

  it('所有者不匹配时归类为解密失败（不泄露区分信息）', () => {
    const decryptor = new ModelCredentialDecryptor(KEY_BASE64, 'local-v1');
    expect(() => decryptor.decrypt('99999999-2222-3333-4444-555555555555', PYTHON_VECTOR_ENVELOPE)).toThrow(
      expect.objectContaining({ code: MODEL_CREDENTIAL_DECRYPTION_FAILED }),
    );
  });

  it('未配置主密钥时给出 CREDENTIAL_ENCRYPTION_UNAVAILABLE', () => {
    const decryptor = new ModelCredentialDecryptor(null, 'local-v1');
    expect(() => decryptor.decrypt(PYTHON_VECTOR_OWNER, PYTHON_VECTOR_ENVELOPE)).toThrow(
      expect.objectContaining({ code: CREDENTIAL_ENCRYPTION_UNAVAILABLE }),
    );
  });

  it('密钥版本不一致时给出 CREDENTIAL_ENCRYPTION_KEY_VERSION_UNSUPPORTED', () => {
    const decryptor = new ModelCredentialDecryptor(KEY_BASE64, 'v2');
    expect(() => decryptor.decrypt(PYTHON_VECTOR_OWNER, PYTHON_VECTOR_ENVELOPE)).toThrow(
      expect.objectContaining({ code: CREDENTIAL_ENCRYPTION_KEY_VERSION_UNSUPPORTED }),
    );
  });

  it('主密钥不是 32 字节时给出 CREDENTIAL_ENCRYPTION_KEY_INVALID', () => {
    const decryptor = new ModelCredentialDecryptor(Buffer.alloc(16, 1).toString('base64'), 'local-v1');
    expect(() => decryptor.decrypt(PYTHON_VECTOR_OWNER, PYTHON_VECTOR_ENVELOPE)).toThrow(
      expect.objectContaining({ code: CREDENTIAL_ENCRYPTION_KEY_INVALID }),
    );
  });

  it('非严格 Base64 与长度错误的 IV/标签都归类为编码错误', () => {
    const decryptor = new ModelCredentialDecryptor(KEY_BASE64, 'local-v1');

    // Node 的宽松解码会忽略 “!”，这里必须拒绝（Python 使用 b64decode(validate=True)）。
    expect(() =>
      decryptor.decrypt(PYTHON_VECTOR_OWNER, { ...PYTHON_VECTOR_ENVELOPE, ciphertext_base64: 'VO6p5MeEqQ7OT6JWko/RsKSdFZZXmpiyQp52lu!=' }),
    ).toThrow(expect.objectContaining({ code: MODEL_CREDENTIAL_ENCODING_INVALID }));

    expect(() =>
      decryptor.decrypt(PYTHON_VECTOR_OWNER, { ...PYTHON_VECTOR_ENVELOPE, iv_base64: Buffer.alloc(8, 9).toString('base64') }),
    ).toThrow(expect.objectContaining({ code: MODEL_CREDENTIAL_ENCODING_INVALID }));
  });

  it('fromEnvironment 读取环境变量并默认密钥版本为 v1', () => {
    const decryptor = ModelCredentialDecryptor.fromEnvironment();
    expect(decryptor).toBeInstanceOf(ModelCredentialDecryptor);
    expect(new CredentialDecryptionError('X', 'y')).toBeInstanceOf(Error);
  });
});
