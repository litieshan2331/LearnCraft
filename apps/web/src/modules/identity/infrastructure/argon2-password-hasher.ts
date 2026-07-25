/**
 * Argon2id 密码哈希基础设施适配器。
 *
 * 导出：
 * - Argon2PasswordHasher：使用固定 P0 参数生成及验证密码哈希；不存在用户时仍执行一次校验以降低时序差异。
 */

import argon2 from "argon2";

import type { PasswordHasher } from "../domain/authentication";

const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

export class Argon2PasswordHasher implements PasswordHasher {
  private dummyHashPromise: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2ID_OPTIONS);
  }

  async verify(password: string, passwordHash: string | null): Promise<boolean> {
    const hashToVerify = passwordHash ?? await this.getDummyHash();

    try {
      const matches = await argon2.verify(hashToVerify, password);
      return passwordHash !== null && matches;
    } catch {
      return false;
    }
  }

  private getDummyHash(): Promise<string> {
    this.dummyHashPromise ??= argon2.hash("learncraft-nonexistent-user", ARGON2ID_OPTIONS);
    return this.dummyHashPromise;
  }
}
