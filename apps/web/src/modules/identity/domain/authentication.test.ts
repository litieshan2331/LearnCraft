/**
 * Identity Session 生命周期规则的单元测试。
 *
 * 测试：
 * - shouldRenewSession：验证 24 小时剩余阈值和“超过 12 小时”续期间隔。
 * - getRenewedSessionExpiresAt：验证 15 天绝对有效期上限。
 */

import { describe, expect, it } from "vitest";

import {
  getRenewedSessionExpiresAt,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_RENEWAL_MIN_INTERVAL_MS,
  shouldRenewSession,
} from "./authentication";

describe("Session 受限滑动续期", () => {
  const hourMs = 60 * 60 * 1000;

  it("剩余恰好 24 小时时不续期", () => {
    const now = new Date("2026-07-25T00:00:00.000Z");

    expect(shouldRenewSession({
      expiresAt: new Date(now.getTime() + 24 * hourMs),
      lastSeenAt: new Date(now.getTime() - 13 * hourMs),
    }, now)).toBe(false);
  });

  it("距上次续期恰好 12 小时时不续期", () => {
    const now = new Date("2026-07-25T00:00:00.000Z");

    expect(shouldRenewSession({
      expiresAt: new Date(now.getTime() + 23 * hourMs),
      lastSeenAt: new Date(now.getTime() - SESSION_RENEWAL_MIN_INTERVAL_MS),
    }, now)).toBe(false);
  });

  it("同时跨过两个阈值时允许续期", () => {
    const now = new Date("2026-07-25T00:00:00.000Z");

    expect(shouldRenewSession({
      expiresAt: new Date(now.getTime() + 23 * hourMs),
      lastSeenAt: new Date(now.getTime() - SESSION_RENEWAL_MIN_INTERVAL_MS - 1),
    }, now)).toBe(true);
  });

  it("续期不会越过从创建时起计算的 15 天绝对上限", () => {
    const createdAt = new Date("2026-07-10T00:00:00.000Z");
    const now = new Date(createdAt.getTime() + SESSION_ABSOLUTE_TTL_MS - 2 * hourMs);

    expect(getRenewedSessionExpiresAt(now, createdAt).toISOString())
      .toBe(new Date(createdAt.getTime() + SESSION_ABSOLUTE_TTL_MS).toISOString());
  });
});
