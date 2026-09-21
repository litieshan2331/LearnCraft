/**
 * AgentRun 实时进度的 SSE HTTP 适配器。
 *
 * 职责：把「订阅进度事件」适配为 `text/event-stream` 响应：写 SSE 帧、定期发送 keep-alive 注释、
 * 在客户端断开时释放订阅。设计取舍：
 * - **不做重放**：进度是临时通道，连接前后已发生的事件不补发（前端只需覆盖生成过程）；
 * - **优雅降级**：订阅不可用时仍返回 200 与正常 SSE 流，只发 keep-alive，前端维持现有等待界面；
 * - 事件来自 infrastructure 的订阅适配器，本文件只负责协议与生命周期。
 *
 * 导出：
 * - AGENT_PROGRESS_KEEP_ALIVE_MS：keep-alive 间隔。
 * - createAgentProgressSseResponse：构造 SSE 响应。
 */

import { NextResponse } from "next/server";

import type {
  AgentProgressEvent,
  AgentProgressSubscription,
} from "../infrastructure/agent-progress-subscriber";

export const AGENT_PROGRESS_KEEP_ALIVE_MS = 15_000;

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // 关闭 Nginx 等反向代理的缓冲，否则事件会被攒着一起发。
  "x-accel-buffering": "no",
} as const;

export function createAgentProgressSseResponse(input: {
  runId: string;
  subscribe: (input: {
    runId: string;
    onEvent: (event: AgentProgressEvent) => void;
  }) => Promise<AgentProgressSubscription>;
  signal: AbortSignal;
}): NextResponse {
  const encoder = new TextEncoder();
  let subscription: AgentProgressSubscription | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const release = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    if (keepAliveTimer !== null) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    await subscription?.close().catch(() => undefined);
    subscription = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: string): void => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          void release();
        }
      };

      keepAliveTimer = setInterval(() => {
        enqueue(": keep-alive\n\n");
      }, AGENT_PROGRESS_KEEP_ALIVE_MS);

      input.signal.addEventListener("abort", () => {
        void release().then(() => {
          try {
            controller.close();
          } catch {
            // 客户端已断开，忽略关闭异常。
          }
        });
      });

      try {
        subscription = await input.subscribe({
          runId: input.runId,
          onEvent: (event) => {
            enqueue("data: " + JSON.stringify(event) + "\n\n");
          },
        });
      } catch {
        // 降级：不向前端暴露通道故障，只保持心跳，等待状态轮询给出结果。
      }
    },
    async cancel() {
      await release();
    },
  });

  return new NextResponse(stream, { headers: SSE_HEADERS });
}
