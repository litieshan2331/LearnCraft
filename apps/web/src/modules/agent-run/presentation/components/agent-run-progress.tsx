/**
 * AgentRun 实时进度面板（仅生成过程中呈现，生成结束后随父组件卸载而消失）。
 *
 * 组件与函数：
 * - AgentRunProgress：订阅 `/api/v1/agent-runs/{id}/progress` 的 SSE 事件，渲染可折叠的步骤时间线，
 *   以及**流式**模型思考原文（thinking.delta 增量逐块追加，thinking.completed 到达时用该轮权威整段覆盖，
 *   因此流中断重试造成的重复片段会自动被纠正）。未收到任何事件时不渲染（由父组件现有等待界面承担）。
 *   进度通道不重放，为了刷新后仍能看到此前收到的思考，状态按 runId 暂存到 sessionStorage
 *   （见 agent-progress-storage.ts）：挂载时恢复、之后的新增量继续追加，运行结束即清理。
 * - describeProgressEvent：把 worker 的 step code 映射为面向用户的中文文案（文案只在前端维护）。
 * - appendThinkingDelta / replaceThinkingTurn / foldThinkingText：按轮次维护并拼接思考原文。
 *
 * 约束：除思考原文外不接收模型输出；思考与事件只存于组件状态与**本标签页的 sessionStorage**，
 * 不上服务器、不落库、不写日志，关闭标签页即消失。
 */

"use client";

import { ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  clearAgentProgressSnapshot,
  readAgentProgressSnapshot,
  writeAgentProgressSnapshot,
} from "../agent-progress-storage";

/** 最多保留的事件条数，避免长时间运行时无限增长（思考增量单独存，不占这里的额度）。 */
const MAX_RETAINED_EVENTS = 30;

/** 思考原文在浏览器里保留的最大字符数（只显示最近部分，避免长会话堆积）。 */
const MAX_THINKING_CHARS = 6_000;

/** 暂存写入的最小间隔：思考增量密集到达，逐条写 sessionStorage 不划算。 */
const STORAGE_WRITE_INTERVAL_MS = 1_000;

interface ProgressEvent {
  v: 1;
  step: string;
  at: string;
  seq: number;
  data?: Record<string, string | number | boolean>;
}

/** 一轮的思考原文（按轮次累积）。 */
interface ThinkingTurn {
  turn: number;
  text: string;
}

export function AgentRunProgress({
  runId,
  className,
}: Readonly<{ runId: string; className?: string }>) {
  // 刷新恢复：首屏直接从本标签页的暂存快照初始化（该面板只在客户端挂载、不参与 SSR），
  // 之后从 SSE 订阅到的新增量继续追加；无快照或读取失败时为空数组。
  const [events, setEvents] = useState<ProgressEvent[]>(
    () => readAgentProgressSnapshot(runId)?.events ?? [],
  );
  const [thinkingTurns, setThinkingTurns] = useState<ThinkingTurn[]>(
    () => readAgentProgressSnapshot(runId)?.thinkingTurns ?? [],
  );
  const [expanded, setExpanded] = useState(false);
  const thinkingRef = useRef<HTMLPreElement | null>(null);

  // 不在此重置状态：调用方以 key={runId} 挂载，换运行时组件会整体重挂载。
  useEffect(() => {
    let active = true;
    const source = new EventSource("/api/v1/agent-runs/" + runId + "/progress");

    source.onmessage = (message) => {
      if (!active) {
        return;
      }
      const parsed = parseProgressEvent(message.data);
      if (parsed === null) {
        return;
      }
      // 思考增量只进思考区，不进时间线（否则会迅速挤掉步骤事件）。
      if (parsed.step === "thinking.delta") {
        setThinkingTurns((previous) => appendThinkingDelta(previous, parsed));
        return;
      }
      setEvents((previous) => [...previous, parsed].slice(-MAX_RETAINED_EVENTS));
      if (parsed.step === "thinking.completed") {
        setThinkingTurns((previous) => replaceThinkingTurn(previous, parsed));
      }
    };
    // 出错即关闭：避免 EventSource 自动重连造成重复订阅；结果仍由状态轮询给出。
    source.onerror = () => source.close();

    return () => {
      active = false;
      source.close();
    };
  }, [runId]);

  const lastStoredAtRef = useRef(0);

  // 暂存到本标签页：限频写入（每秒最多一次）；运行结束（run.completed/run.failed）立即清理，
  // 避免把已结束运行的思考留在会话里。读写失败都在暂存模块内部静默忽略。
  useEffect(() => {
    const finished = events.some(
      (event) => event.step === "run.completed" || event.step === "run.failed",
    );
    if (finished) {
      clearAgentProgressSnapshot(runId);
      return;
    }
    if (events.length === 0 && thinkingTurns.length === 0) {
      return;
    }
    const now = Date.now();
    if (now - lastStoredAtRef.current < STORAGE_WRITE_INTERVAL_MS) {
      return;
    }
    lastStoredAtRef.current = now;
    writeAgentProgressSnapshot(runId, { events, thinkingTurns });
  }, [runId, events, thinkingTurns]);

  const thinkingText = foldThinkingText(thinkingTurns);

  // 新内容到达时滚到底部（只读 DOM，不改状态）。
  useEffect(() => {
    const node = thinkingRef.current;
    if (node !== null) {
      node.scrollTop = node.scrollHeight;
    }
  }, [thinkingText]);

  if (events.length === 0 && thinkingText.length === 0) {
    return null;
  }

  const latest = events[events.length - 1];
  const latestText = latest === undefined ? "模型正在思考…" : describeProgressEvent(latest);
  const canExpand = events.length > 1;

  return (
    <div className={"mt-4 rounded-xl border border-border/70 bg-secondary/35 px-4 py-3" + (className ? " " + className : "")}>
      <div className="flex items-start gap-3">
        <LoaderCircle aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm leading-6 text-foreground">{latestText}</p>
          {canExpand ? (
            <button
              aria-expanded={expanded}
              className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setExpanded((value) => !value)}
              type="button"
            >
              {expanded ? "收起步骤" : "展开步骤（" + String(events.length) + " 步）"}
              <ChevronDown aria-hidden className={"size-3.5 transition-transform" + (expanded ? " rotate-180" : "")} />
            </button>
          ) : null}
        </div>
      </div>

      {thinkingText.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">模型思考过程（仅生成过程中可见，不会保存）</p>
          <pre
            className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 p-3 text-xs leading-5 text-muted-foreground"
            ref={thinkingRef}
          >
            {thinkingText}
          </pre>
        </div>
      ) : null}

      {expanded ? (
        <ol className="mt-3 space-y-2 border-l border-border/70 pl-4">
          {events.map((event) => (
            <li className="text-xs leading-5 text-muted-foreground" key={String(event.seq) + event.step + event.at}>
              <span className="tabular-nums text-muted-foreground/70">{formatClock(event.at)}</span>
              {" · "}
              {describeProgressEvent(event)}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** 追加一段思考增量到对应轮次。 */
function appendThinkingDelta(turns: ThinkingTurn[], event: ProgressEvent): ThinkingTurn[] {
  const text = readText(event.data?.text);
  if (text.length === 0) {
    return turns;
  }
  const turn = readTurn(event);
  const index = turns.findIndex((item) => item.turn === turn);
  if (index < 0) {
    return [...turns, { turn, text }];
  }
  const next = [...turns];
  const current = next[index];
  next[index] = { turn, text: (current?.text ?? "") + text };
  return next;
}

/** 用该轮的权威整段覆盖已累积的增量（流中断重试的重复片段会在这里被纠正）。 */
function replaceThinkingTurn(turns: ThinkingTurn[], event: ProgressEvent): ThinkingTurn[] {
  const text = readText(event.data?.text);
  const turn = readTurn(event);
  const index = turns.findIndex((item) => item.turn === turn);
  if (index < 0) {
    return text.length === 0 ? turns : [...turns, { turn, text }];
  }
  const next = [...turns];
  next[index] = { turn, text };
  return next;
}

/** 按轮次拼接思考原文，只保留最近 MAX_THINKING_CHARS 个字符。 */
function foldThinkingText(turns: ThinkingTurn[]): string {
  const joined = turns
    .map((item) => item.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
  return joined.length > MAX_THINKING_CHARS ? joined.slice(-MAX_THINKING_CHARS) : joined;
}

/** 读取事件里的轮次号；非法时归到第 0 轮（仍然显示）。 */
function readTurn(event: ProgressEvent): number {
  const turn = event.data?.turn;
  if (typeof turn === "number" && Number.isFinite(turn)) {
    return turn;
  }
  if (typeof turn === "string") {
    const parsed = Number(turn);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** 读取事件里的文本参数；非字符串返回空串。 */
function readText(value: string | number | boolean | undefined): string {
  return typeof value === "string" ? value : "";
}

/** 解析 SSE data；结构不符时返回 null（丢弃）。 */
function parseProgressEvent(raw: string): ProgressEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Partial<ProgressEvent>;
    if (typeof candidate.step !== "string" || typeof candidate.seq !== "number") {
      return null;
    }
    return {
      v: 1,
      step: candidate.step,
      at: typeof candidate.at === "string" ? candidate.at : new Date().toISOString(),
      seq: candidate.seq,
      ...(candidate.data === undefined ? {} : { data: candidate.data }),
    };
  } catch {
    return null;
  }
}

/** 把 step code 与参数映射为面向用户的中文文案。 */
function describeProgressEvent(event: ProgressEvent): string {
  const data = event.data ?? {};
  const turn = data.turn === undefined ? "" : String(data.turn);

  switch (event.step) {
    case "run.preparing":
      return "正在准备模型连接与凭据…";
    case "turn.started":
      return turn.length > 0 ? "第 " + turn + " 轮思考中…" : "正在思考…";
    case "thinking.completed":
      return turn.length > 0 ? "第 " + turn + " 轮思考已记录" : "已记录模型思考过程";
    case "tool.called": {
      const query = data.query === undefined ? "" : String(data.query);
      const callIndex = data.call_index === undefined ? "" : String(data.call_index);
      const suffix = callIndex.length > 0 ? "（第 " + callIndex + " 次联网）" : "";
      return query.length > 0 ? "正在检索：" + query + suffix : "正在联网检索资料" + suffix;
    }
    case "tool.completed":
      if (data.ok === false) {
        return "联网检索未成功（" + String(data.code ?? "未知原因") + "），模型将改用已有知识继续";
      }
      return data.source_count === undefined
        ? "已获取联网资料，正在整理…"
        : "已获取 " + String(data.source_count) + " 条资料，正在整理…";
    case "validation.failed":
      return "输出未通过结构校验" + (data.paths === undefined ? "" : "（" + String(data.paths) + "）");
    case "turn.self_correcting":
      return "正在按校验反馈修正…";
    case "result.persisting":
      return "正在保存生成结果…";
    case "run.completed":
      return "生成完成，正在打开结果…";
    case "run.failed":
      return data.retryable === true
        ? "本轮模型调用失败，任务将自动重试…"
        : "生成未能完成";
    default:
      return "处理中…";
  }
}

/** 只显示时分秒，避免因本地化产生歧义。 */
function formatClock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}
