/**
 * Agent 观测查询参数和游标的单元测试。
 *
 * 调用顺序：先校验列表复合游标，再校验事件续传游标与非法参数。
 */

import { describe, expect, it } from "vitest";

import { decodeTraceRunCursor, encodeTraceRunCursor, parseTraceEventQuery, parseTraceRunListQuery } from "./agent-trace-http";

const RUN_ID = "11111111-2222-4333-8444-555555555555";

describe("Agent 观测游标", () => {
  it("运行列表复合游标可往返，还原时间和 ID", () => {
    const cursor = { createdAt: new Date("2026-09-29T00:00:00.123Z"), id: RUN_ID };
    const encoded = encodeTraceRunCursor(cursor);
    expect(decodeTraceRunCursor(encoded)).toEqual(cursor);
    expect(parseTraceRunListQuery(new URLSearchParams({ cursor: encoded })).success).toBe(true);
  });

  it("拒绝无效列表游标，避免跳页或 SQL 错误", () => {
    expect(parseTraceRunListQuery(new URLSearchParams({ cursor: "bad" })).success).toBe(false);
    expect(parseTraceRunListQuery(new URLSearchParams({ limit: "101" })).success).toBe(false);
  });

  it("事件 after 优先于 Last-Event-ID，且拒绝负数或小数", () => {
    expect(parseTraceEventQuery(new URLSearchParams({ after: "8" }), "5")).toMatchObject({
      success: true, data: { after: 8 },
    });
    expect(parseTraceEventQuery(new URLSearchParams(), "5")).toMatchObject({
      success: true, data: { after: 5 },
    });
    expect(parseTraceEventQuery(new URLSearchParams({ after: "-1" })).success).toBe(false);
    expect(parseTraceEventQuery(new URLSearchParams({ after: "1.2" })).success).toBe(false);
  });
});
