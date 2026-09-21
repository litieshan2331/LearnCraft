/**
 * AgentRun 实时进度的 Redis 订阅适配器（B2：Pub/Sub 临时通道，不落库）。
 *
 * 职责：订阅 Agent Worker 发布的 `learncraft:agent-progress:{runId}` 频道，把消息解析为受校验的
 * 进度事件。三条约束：
 * 1. 只订阅由已授权 runId 派生的频道，不接受任意频道名；
 * 2. 每条消息都经 Zod 白名单校验，非法或超长内容直接丢弃（防御脏数据/敌意数据）；
 *    `thinking.completed` 的 `data.text` 是模型思考原文：只转发给当前登录的所有者，不落库、不写日志；
 * 3. 未配置 `AGENT_PROGRESS_REDIS_URL` 或连接失败时抛 AgentProgressUnavailableError，
 *    由上层降级为「没有实时进度」，不影响状态轮询与最终结果。
 *
 * 导出：
 * - AGENT_PROGRESS_CHANNEL_PREFIX / agentProgressChannel：与 Worker 一致的频道命名。
 * - AgentProgressStep：允许上报的步骤 code 集合。
 * - AgentProgressEvent：校验后的事件结构。
 * - AgentProgressUnavailableError：订阅通道不可用。
 * - AgentProgressSubscription：可关闭的订阅句柄。
 * - subscribeAgentProgress：建立一次订阅。
 */

import { createClient } from "redis";
import { z } from "zod";

export const AGENT_PROGRESS_CHANNEL_PREFIX = "learncraft:agent-progress:";

export const AGENT_PROGRESS_STEPS = [
  "run.preparing",
  "turn.started",
  // 这两个事件的 data.text 是模型思考原文（唯一允许携带模型原文的事件）：
  // thinking.delta 为流式增量，thinking.completed 为该轮权威整段。
  "thinking.delta",
  "thinking.completed",
  "tool.called",
  "tool.completed",
  "validation.failed",
  "turn.self_correcting",
  "result.persisting",
  "run.completed",
  "run.failed",
] as const;

/** 单个字符串参数的长度上限：思考原文较长，其余字段远小于此值。 */
const AGENT_PROGRESS_TEXT_MAX = 4_000;

export const agentProgressEventSchema = z.object({
  v: z.literal(1),
  step: z.enum(AGENT_PROGRESS_STEPS),
  at: z.string().min(1).max(40),
  seq: z.number().int().min(0).max(10_000),
  data: z
    .record(
      z.string().max(40),
      z.union([z.string().max(AGENT_PROGRESS_TEXT_MAX), z.number(), z.boolean()]),
    )
    .optional(),
});

export type AgentProgressStep = (typeof AGENT_PROGRESS_STEPS)[number];
export type AgentProgressEvent = z.infer<typeof agentProgressEventSchema>;

export class AgentProgressUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProgressUnavailableError";
  }
}

export interface AgentProgressSubscription {
  close(): Promise<void>;
}

export function agentProgressChannel(runId: string): string {
  return AGENT_PROGRESS_CHANNEL_PREFIX + runId;
}

/** 建立一次订阅；连接或订阅失败时抛 AgentProgressUnavailableError。 */
export async function subscribeAgentProgress(input: {
  runId: string;
  onEvent: (event: AgentProgressEvent) => void;
}): Promise<AgentProgressSubscription> {
  const url = process.env.AGENT_PROGRESS_REDIS_URL?.trim();
  if (!url) {
    throw new AgentProgressUnavailableError("AGENT_PROGRESS_REDIS_URL 未配置，实时进度不可用。");
  }

  const client = createClient({
    url,
    socket: { connectTimeout: 2_000, reconnectStrategy: false },
    disableOfflineQueue: true,
  });
  // 连接错误由调用方降级处理，不能因未监听的 error 事件终止进程。
  client.on("error", () => undefined);

  try {
    await client.connect();
    await client.subscribe(agentProgressChannel(input.runId), (message) => {
      const event = parseAgentProgressEvent(message);
      if (event !== null) {
        input.onEvent(event);
      }
    });
  } catch (error) {
    await client.quit().catch(() => undefined);
    throw new AgentProgressUnavailableError(
      "实时进度订阅失败：" + (error instanceof Error ? error.message : "未知错误"),
    );
  }

  return {
    close: async () => {
      await client.unsubscribe(agentProgressChannel(input.runId)).catch(() => undefined);
      await client.quit().catch(() => undefined);
    },
  };
}

/** 解析并校验一条频道消息；非法内容返回 null（丢弃，不抛错）。 */
export function parseAgentProgressEvent(message: string): AgentProgressEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return null;
  }
  const parsed = agentProgressEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
