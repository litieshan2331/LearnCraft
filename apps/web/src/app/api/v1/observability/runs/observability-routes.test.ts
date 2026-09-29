/**
 * Agent 观测路由的 owner_id 隔离测试。
 *
 * 调用顺序：模拟登录用户和只读仓储，依次调用列表、摘要、分页与 SSE，
 * 验证各路径只把 Session 中的 ownerId 传给查询层，其他用户运行统一 404。
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as listRuns } from "./route";
import { GET as getRun } from "./[runId]/route";
import { GET as getEvents } from "./[runId]/events/route";
import { GET as streamEvents } from "./[runId]/events/stream/route";

const OWNER_ID = "11111111-2222-4333-8444-555555555555";
const RUN_ID = "66666666-7777-4888-9999-000000000000";

const queries = vi.hoisted(() => ({
  listTraceRuns: vi.fn(),
  findTraceRun: vi.fn(),
  findTraceRunStatus: vi.fn(),
  listTraceEvents: vi.fn(),
}));
const sseFactory = vi.hoisted(() => vi.fn());

vi.mock("@/modules/agent-run/infrastructure/agent-trace-query", () => queries);
vi.mock("@/modules/agent-run/interfaces/agent-run-http", () => ({
  agentRunPathSchema: { safeParse: (value: { agent_run_id: string }) => ({ success: true, data: value }) },
  authenticateAgentRunRequest: async () => ({
    authenticated: true, ownerId: OWNER_ID, rawSessionToken: "test", renewedSessionExpiresAt: null,
  }),
  applyAgentRunSessionRenewal: (response: NextResponse) => response,
}));
vi.mock("@/modules/agent-run/interfaces/agent-trace-http", () => ({
  parseTraceRunListQuery: () => ({ success: true, data: { limit: 20 } }),
  parseTraceEventQuery: (params: URLSearchParams) => ({
    success: true, data: { after: Number(params.get("after") ?? 0), limit: 50 },
  }),
  presentTraceRun: (value: unknown) => value,
  presentTraceEvent: (value: unknown) => value,
  encodeTraceRunCursor: () => "cursor",
}));
vi.mock("@/modules/agent-run/interfaces/agent-trace-sse", () => ({ createAgentTraceSseResponse: sseFactory }));
vi.mock("@/modules/identity/interfaces/auth-http", () => ({
  apiErrorResponse: (status: number, code: string) => NextResponse.json({ code }, { status }),
  validationErrorResponse: () => NextResponse.json({ code: "VALIDATION_ERROR" }, { status: 422 }),
}));

/** 构造四个接口共用的测试 Request。 */
function request(suffix: string): Request {
  return new Request(`http://localhost/api/v1/observability/runs${suffix}`);
}

describe("观测接口的用户隔离", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queries.listTraceRuns.mockResolvedValue({ items: [], hasMore: false });
    queries.findTraceRun.mockResolvedValue(null);
    queries.findTraceRunStatus.mockResolvedValue(null);
    queries.listTraceEvents.mockResolvedValue({ items: [], hasMore: false });
    sseFactory.mockImplementation(() => NextResponse.json({ streaming: true }));
  });

  it("列表只查询当前 Session 的 ownerId", async () => {
    const response = await listRuns(request(""));
    expect(response.status).toBe(200);
    expect(queries.listTraceRuns).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER_ID }));
  });

  it("摘要、事件分页和 SSE 对其他用户运行统一 404，不读取事件", async () => {
    const context = { params: Promise.resolve({ runId: RUN_ID }) };
    const responses = await Promise.all([
      getRun(request(`/${RUN_ID}`), context),
      getEvents(request(`/${RUN_ID}/events`), context),
      streamEvents(request(`/${RUN_ID}/events/stream`), context),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(queries.findTraceRun).toHaveBeenCalledWith(OWNER_ID, RUN_ID);
    expect(queries.findTraceRunStatus).toHaveBeenCalledWith(OWNER_ID, RUN_ID);
    expect(queries.listTraceEvents).not.toHaveBeenCalled();
  });

  it("已归属运行的事件分页和 SSE 都绑定 ownerId 查询", async () => {
    queries.findTraceRunStatus.mockResolvedValue("running");
    const context = { params: Promise.resolve({ runId: RUN_ID }) };
    const page = await getEvents(request(`/${RUN_ID}/events?after=3`), context);
    expect(page.status).toBe(200);
    expect(queries.listTraceEvents).toHaveBeenCalledWith(OWNER_ID, RUN_ID, 3, 50);

    const abort = new AbortController();
    const streamRequest = new Request(`http://localhost/api/v1/observability/runs/${RUN_ID}/events/stream?after=3`, {
      signal: abort.signal,
    });
    const stream = await streamEvents(streamRequest, context);
    expect(stream.status).toBe(200);
    const streamInput = sseFactory.mock.calls[0]?.[0] as { after: number; readPage: (after: number) => Promise<unknown> };
    expect(streamInput.after).toBe(3);
    await streamInput.readPage(3);
    abort.abort();
    expect(queries.listTraceEvents).toHaveBeenCalledWith(OWNER_ID, RUN_ID, 3, 100);
  });
});
