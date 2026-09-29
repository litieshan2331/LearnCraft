/**
 * Agent 完整观测事件的可重放 SSE 适配器。
 *
 * 调用顺序：`createAgentTraceSseResponse` 先按 after 补发 PostgreSQL 事件，
 * 然后每隔短时间查询新增事件；终态且事件已读尽时关闭，断线时释放计时器。
 */

import { NextResponse } from "next/server";

import { presentTraceEvent } from "./agent-trace-http";

type TraceEvent = Parameters<typeof presentTraceEvent>[0];

export interface TraceEventPage {
  items: TraceEvent[];
  hasMore: boolean;
}

export const AGENT_TRACE_POLL_MS = 1_500;
export const AGENT_TRACE_KEEP_ALIVE_MS = 15_000;

/** 运行已进入不可再追加事件的终态。 */
function isTerminal(status: string | null): boolean {
  return status === null || ["succeeded", "failed", "cancelled", "expired"].includes(status);
}

/** 构建按序重放和持续追加的 SSE 响应。 */
export function createAgentTraceSseResponse(input: {
  after: number;
  signal: AbortSignal;
  readPage: (after: number) => Promise<TraceEventPage>;
  readStatus: () => Promise<string | null>;
  pollMs?: number;
  keepAliveMs?: number;
}): NextResponse {
  const encoder = new TextEncoder();
  let closed = false;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  let pullWake: (() => void) | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  /** 关闭流并唤醒等待中的轮询，释放计时器。 */
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (pollTimer) clearTimeout(pollTimer);
    input.signal.removeEventListener("abort", close);
    wake?.();
    pullWake?.();
    try { controller?.close(); } catch { /* 客户端已断开。 */ }
  };

  /** 写入一个 SSE 帧；断线时停止后续轮询。 */
  const enqueue = (frame: string): void => {
    if (closed) return;
    try { controller?.enqueue(encoder.encode(frame)); } catch { close(); }
  };

  /** 大型 JSONB 轨迹回放时等待客户端消费，避免将整段历史堆入内存。 */
  const waitForPull = (): Promise<void> => new Promise((resolve) => { pullWake = resolve; });

  /** 在两次无新增事件的查询之间等待，可被断线立即打断。 */
  const wait = (): Promise<void> => new Promise((resolve) => {
    wake = resolve;
    pollTimer = setTimeout(() => { wake = null; pollTimer = null; resolve(); }, input.pollMs ?? AGENT_TRACE_POLL_MS);
  });

  /** 从指定游标连续补发，随后持续追加，终态读尽后结束。 */
  const pump = async (): Promise<void> => {
    let after = input.after;
    let terminalQuietPolls = 0;
    try {
      while (!closed) {
        const page = await input.readPage(after);
        if (closed) return;
        let terminalEventSeen = false;
        for (const event of page.items) {
          if (event.sequenceNo <= after) continue;
          after = event.sequenceNo;
          if (event.eventType === "run.completed" || event.eventType === "run.failed") terminalEventSeen = true;
          enqueue(`id: ${after}\nevent: trace\ndata: ${JSON.stringify(presentTraceEvent(event))}\n\n`);
          if (!closed && (controller?.desiredSize ?? 1) <= 0) await waitForPull();
        }
        if (page.hasMore) continue;
        if (isTerminal(await input.readStatus())) {
          // Worker 先写终态再写结束轨迹；短暂等待尾事件，避免终态竞态丢失最后一帧。
          terminalQuietPolls = page.items.length > 0 ? 0 : terminalQuietPolls + 1;
          if (terminalEventSeen || terminalQuietPolls >= 3) { close(); return; }
        } else {
          terminalQuietPolls = 0;
        }
        if (!closed) await wait();
      }
    } catch {
      enqueue("event: error\ndata: {\"code\":\"TRACE_STREAM_UNAVAILABLE\"}\n\n");
      close();
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    /** 建立心跳及初次查询。 */
    start(streamController) {
      controller = streamController;
      input.signal.addEventListener("abort", close, { once: true });
      if (input.signal.aborted) { close(); return; }
      keepAliveTimer = setInterval(() => enqueue(": keep-alive\n\n"), input.keepAliveMs ?? AGENT_TRACE_KEEP_ALIVE_MS);
      void pump();
    },
    /** 客户端取走队列内容后继续数据库回放。 */
    pull() { const resume = pullWake; pullWake = null; resume?.(); },
    /** 客户端断开时终止轮询。 */
    cancel() { close(); },
  });

  return new NextResponse(stream, { headers: {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  } });
}
