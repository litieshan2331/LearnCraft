/**
 * LearnCraft Agent 轨迹展示层（移植 DSH ui-trajectory 的纯展示结构）。
 *
 * 调用顺序：`TraceTrajectoryView` 通过工具栏筛选事件，`groupEventsByTurn` 按轮次分组，
 * `TraceEventRow` 展示时间线和摘要，选中后由 `TraceJsonViewer` 展开完整 Prompt、Thinking、Tool 输入/输出。
 */

"use client";

import { ChevronDown, ChevronRight, CircleAlert, Clock3, Search, Wifi, WifiOff } from "lucide-react";
import { useMemo, useState } from "react";

import { TraceJsonViewer } from "./trace-json-viewer";

export interface TraceEvent {
  sequence_no: number;
  event_type: string;
  turn_no: number | null;
  step_no: number | null;
  attempt_no: number | null;
  started_at: string | null;
  finished_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export type TraceConnectionState = "connecting" | "live" | "disconnected" | "closed";

/** 将事件按 turn 分组；没有轮次的运行级事件归入“运行”。 */
function groupEventsByTurn(events: readonly TraceEvent[]): Array<{ key: string; label: string; events: TraceEvent[] }> {
  const groups = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const key = event.turn_no === null ? "run" : `turn-${event.turn_no}`;
    const current = groups.get(key) ?? [];
    current.push(event);
    groups.set(key, current);
  }
  return [...groups.entries()].map(([key, grouped]) => ({
    key,
    label: key === "run" ? "运行生命周期" : `第 ${grouped[0]?.turn_no ?? "-"} 轮`,
    events: grouped,
  }));
}

/** 将事件类型转换为用户可扫描的中文标签。 */
function eventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    "run.started": "运行开始", "run.completed": "运行完成", "run.failed": "运行失败",
    "llm.request.started": "模型请求", "llm.attempt.completed": "模型完成",
    "llm.attempt.failed": "模型失败", "llm.retry": "模型重试", "llm.fallback": "模型回退",
    "tool.started": "工具开始", "tool.completed": "工具完成",
  };
  return labels[eventType] ?? eventType;
}

/** 返回事件类型对应的视觉颜色。 */
function eventTone(eventType: string): string {
  if (eventType.includes("failed")) return "border-destructive/30 bg-destructive/10 text-destructive";
  if (eventType.includes("retry") || eventType.includes("fallback")) return "border-chart-4/40 bg-chart-4/15 text-foreground";
  if (eventType.startsWith("llm")) return "border-primary/25 bg-primary/10 text-primary";
  if (eventType.startsWith("tool")) return "border-chart-2/30 bg-chart-2/10 text-foreground";
  return "border-border bg-secondary/70 text-muted-foreground";
}

/** 格式化事件时间和耗时，缺少结束时间时不虚构耗时。 */
function formatEventTiming(event: TraceEvent): string {
  const started = event.started_at ? new Date(event.started_at) : null;
  const finished = event.finished_at ? new Date(event.finished_at) : null;
  const time = started && Number.isFinite(started.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(started)
    : "时间未知";
  if (!started || !finished || !Number.isFinite(finished.getTime())) return time;
  return `${time} · ${Math.max(0, finished.getTime() - started.getTime())} ms`;
}

/** 获取事件卡片中的简短标题。 */
function eventSummary(event: TraceEvent): string {
  const payload = event.payload;
  const model = typeof payload.model === "string" ? payload.model : null;
  const name = typeof payload.name === "string" ? payload.name : null;
  const errorCode = typeof payload.errorCode === "string" ? payload.errorCode : null;
  return errorCode ?? name ?? model ?? eventLabel(event.event_type);
}

/** 单条轨迹事件卡片，点击后展示完整 JSONB。 */
function TraceEventRow({ event, selected, onSelect }: Readonly<{ event: TraceEvent; selected: boolean; onSelect: () => void }>) {
  const response = event.payload.response;
  const requestPayload = event.payload.payload;
  return (
    <article className={`rounded-2xl border bg-card/85 transition-colors ${selected ? "border-primary/50 shadow-[0_14px_35px_-28px_rgba(36,122,128,0.9)]" : "border-border/75"}`}>
      <button className="flex w-full items-start gap-3 p-4 text-left" onClick={onSelect} type="button">
        <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl border text-xs font-medium ${eventTone(event.event_type)}`}>{event.sequence_no}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{eventLabel(event.event_type)}</span><span className={`rounded-full border px-2 py-0.5 text-[10px] ${eventTone(event.event_type)}`}>{event.event_type}</span></span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">{eventSummary(event)}</span>
          <span className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground"><span className="inline-flex items-center gap-1"><Clock3 aria-hidden className="size-3" />{formatEventTiming(event)}</span>{event.input_tokens !== null || event.output_tokens !== null ? <span>Token {event.input_tokens ?? 0} / {event.output_tokens ?? 0}</span> : null}{event.attempt_no !== null ? <span>尝试 {event.attempt_no}</span> : null}</span>
        </span>
        {selected ? <ChevronDown aria-hidden className="mt-1 size-4 shrink-0 text-primary" /> : <ChevronRight aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />}
      </button>
      {selected ? (
        <div className="space-y-3 border-t border-border/70 bg-background/35 p-4">
          {requestPayload !== undefined ? <TraceJsonViewer label="实际 Provider 请求（最终 Prompt / 配置）" value={requestPayload} /> : null}
          {response !== undefined ? <TraceJsonViewer label="模型正文、Thinking 与 Tool Calls" value={response} /> : null}
          {event.payload.arguments !== undefined ? <TraceJsonViewer label="Tool 原始输入" value={event.payload.arguments} /> : null}
          {event.payload.result !== undefined ? <TraceJsonViewer label="Tool 原始输出" value={event.payload.result} /> : null}
          <TraceJsonViewer label="事件完整 Payload" value={event.payload} />
        </div>
      ) : null}
    </article>
  );
}

/** DSH 风格的轨迹时间线、事件表和详情检查器。 */
export function TraceTrajectoryView({ events, connectionState }: Readonly<{ events: readonly TraceEvent[]; connectionState: TraceConnectionState }>) {
  const [query, setQuery] = useState("");
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const filteredEvents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return events;
    return events.filter((event) => JSON.stringify(event).toLowerCase().includes(normalized));
  }, [events, query]);
  const groups = useMemo(() => groupEventsByTurn(filteredEvents), [filteredEvents]);

  /** 切换一个轮次分组的折叠状态。 */
  function toggleGroup(key: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,25rem)]">
      <div className="min-w-0 rounded-[1.35rem] border border-border/80 bg-card/75 p-4 shadow-[0_24px_70px_-52px_rgba(23,53,58,0.65)] sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-4">
          <div><p className="text-xs font-medium tracking-[0.16em] text-primary">TRAJECTORY</p><p className="mt-1 text-sm text-muted-foreground">{events.length} 条已落库事件</p></div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">{connectionState === "live" || connectionState === "connecting" ? <Wifi aria-hidden className="size-3.5 text-primary" /> : <WifiOff aria-hidden className="size-3.5 text-chart-4" />}{connectionState === "live" ? "实时连接" : connectionState === "connecting" ? "正在连接" : connectionState === "disconnected" ? "连接断开，自动续传" : "已结束"}</div>
        </div>
        <label className="mt-4 flex items-center gap-2 rounded-xl border border-border/80 bg-background/60 px-3 py-2 text-sm"><Search aria-hidden className="size-4 text-muted-foreground" /><input className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Prompt、模型、Tool 或错误码" value={query} /></label>
        <div className="mt-5 space-y-4">
          {groups.length === 0 ? <div className="rounded-2xl border border-dashed border-primary/25 bg-background/45 px-5 py-12 text-center text-sm text-muted-foreground">没有匹配的轨迹事件</div> : groups.map((group) => (
            <section key={group.key}>
              <button className="mb-2 flex w-full items-center gap-2 px-1 text-left text-sm font-medium" onClick={() => toggleGroup(group.key)} type="button">{collapsed.has(group.key) ? <ChevronRight aria-hidden className="size-4 text-primary" /> : <ChevronDown aria-hidden className="size-4 text-primary" />}<span>{group.label}</span><span className="text-xs font-normal text-muted-foreground">{group.events.length} 条</span></button>
              {!collapsed.has(group.key) ? <div className="space-y-2 border-l-2 border-primary/15 pl-3">{group.events.map((event) => <TraceEventRow event={event} key={event.sequence_no} onSelect={() => setSelectedSequence((current) => current === event.sequence_no ? null : event.sequence_no)} selected={selectedSequence === event.sequence_no} />)}</div> : null}
            </section>
          ))}
        </div>
      </div>
      <aside className="h-fit rounded-[1.35rem] border border-border/80 bg-card/75 p-5 shadow-[0_24px_70px_-52px_rgba(23,53,58,0.65)] lg:sticky lg:top-6">
        <p className="text-xs font-medium tracking-[0.16em] text-primary">INSPECTOR</p>
        <h2 className="mt-2 font-heading text-2xl font-medium">轨迹检查器</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">点击左侧事件查看完整请求、模型输出、Thinking 和 Tool 原始数据。</p>
        {selectedSequence === null ? <div className="mt-6 rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground"><CircleAlert aria-hidden className="mb-2 size-4 text-primary" />选择一条事件开始检查。</div> : <p className="mt-6 text-sm text-muted-foreground">当前选中事件 #{selectedSequence}，详情已在左侧展开。</p>}
      </aside>
    </section>
  );
}
