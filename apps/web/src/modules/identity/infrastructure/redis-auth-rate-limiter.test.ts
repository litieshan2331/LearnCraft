/**
 * Redis 认证限流键的单元测试。
 *
 * 测试：
 * - createRateLimitKey：验证业务前缀、策略分段与敏感主体哈希规则。
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createRateLimitKey } from "./redis-auth-rate-limiter";

describe("Redis 认证限流键", () => {
  it("使用 ratelimit 业务前缀，且不保存明文主体", () => {
    const subject = "reader@example.com:127.0.0.1";
    const subjectHash = createHash("sha256").update(subject).digest("hex");

    expect(createRateLimitKey({ name: "login", limit: 5, windowSeconds: 900 }, subject))
      .toBe(`ratelimit:login:${subjectHash}`);
  });
});
