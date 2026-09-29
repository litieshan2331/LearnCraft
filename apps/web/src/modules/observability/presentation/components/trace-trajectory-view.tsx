/**
 * LearnCraft Agent 轨迹紧凑展示层，复刻 DSH 的 toolbar、时间概览、事件 ledger 和右侧详情面板。
 *
 * 调用顺序：`TraceTrajectoryView` 筛选并选择事件；`TraceEventRow` 展示紧凑行；
 * `TraceDetailPanel` 按标签读取 Prompt、模型结果、Tool 原始数据和计时信息。
 */

"use client";

import { ChevronDown, ChevronRight, Clock3, Search, Wifi, WifiOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
type DetailTab = "overview" | "request" | "result" | "tool" | "timing";

/** 将事件按 turn 分组；没有轮次的运行级事件归入生命周期组。 */
function groupEventsByTurn(events: readonly TraceEvent[]): Array<{ key: string; label: string; events: TraceEvent[] }> {
  const groups = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const key = event.turn_no === null ? "run" : `turn-${event.turn_no}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.entries()].map(([key, grouped]) => ({
    key,
    label: key === "run" ? "运行生命周期" : `第 ${grouped[0]?.turn_no ?? "-"} 轮`,
    events: grouped,
  }));
}

/** 将事件类型转换为用户可扫描的短标签。 */
function eventLabel(eventType: string): string {
  return ({
    "run.started": "运行开始", "run.completed": "运行完成", "run.failed": "运行失败",
    "llm.request.started": "模型请求", "llm.attempt.completed": "模型完成",
    "llm.attempt.failed": "模型失败", "llm.retry": "模型重试", "llm.fallback": "模型回退",
    "tool.started": "工具开始", "tool.completed": "工具完成",
  } as Record<string, string>)[eventType] ?? eventType;
}

/** 返回事件类型对应的紧凑色标。 */
function eventTone(eventType: string): string {
  if (eventType.includes("failed")) return "bg-destructive";
  if (eventType.includes("retry") || eventType.includes("fallback")) return "bg-chart-4";
  // 模型使用青绿色，工具使用高辨识度的紫色；两者在事件圆点和时间轴中保持一致。
  if (eventType.startsWith("llm")) return "bg-teal-500";
  if (eventType.startsWith("tool")) return "bg-violet-500";
  return "bg-muted-foreground/50";
}

/** 格式化时间和耗时；缺少结束时间时只显示开始时间。 */
function formatEventTiming(event: TraceEvent): string {
  const started = event.started_at ? new Date(event.started_at) : null;
  const finished = event.finished_at ? new Date(event.finished_at) : null;
  const time = started && Number.isFinite(started.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(started)
    : "时间未知";
  if (!started || !finished || !Number.isFinite(finished.getTime())) return time;
  return `${time} · ${Math.max(0, finished.getTime() - started.getTime())} ms`;
}

/** 按运行摘要顶部使用的本地时区格式显示事件时间，避免直接展示 UTC ISO 字符串。 */
function formatTraceTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

/** 从 payload 中提取事件摘要，避免在 ledger 行内展开 JSON。 */
function eventSummary(event: TraceEvent): string {
  const payload = event.payload;
  const model = typeof payload.model === "string" ? payload.model : null;
  const name = typeof payload.name === "string" ? payload.name : null;
  const errorCode = typeof payload.errorCode === "string" ? payload.errorCode : null;
  return errorCode ?? name ?? model ?? eventLabel(event.event_type);
}

/** 返回 payload 的指定字段，并让详情面板明确显示未提供。 */
function payloadValue(event: TraceEvent, key: string): unknown {
  return event.payload[key];
}

/** 读取事件 Token；优先使用事件列，兼容旧事件中仅写入 payload.usage 的记录。 */
function eventTokenValue(event: TraceEvent, kind: "input" | "output"): number | null {
  const direct = kind === "input" ? event.input_tokens : event.output_tokens;
  if (direct !== null) return direct;
  const usage = event.payload.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const value = kind === "input"
    ? record.inputTokens ?? record.input_tokens ?? record.prompt_tokens
    : record.outputTokens ?? record.output_tokens ?? record.completion_tokens;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** DSH 风格的一行事件 ledger。 */
function TraceEventRow({ event, selected, onSelect }: Readonly<{ event: TraceEvent; selected: boolean; onSelect: () => void }>) {
  const inputTokens = eventTokenValue(event, "input");
  const outputTokens = eventTokenValue(event, "output");
  return <button className={`grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 border-b px-2.5 py-2 text-left transition-colors last:border-b-0 ${selected ? "border-primary/30 bg-primary/10" : "border-border/55 hover:bg-secondary/35"}`} onClick={onSelect} type="button"><span className={`relative grid size-5 place-items-center rounded-full text-[9px] font-medium text-primary-foreground ${eventTone(event.event_type)}`}>{event.sequence_no}</span><span className="min-w-0"><span className="flex min-w-0 items-center gap-1.5"><span className="truncate text-xs font-medium">{eventLabel(event.event_type)}</span><span className="truncate font-mono text-[9px] text-muted-foreground">{event.event_type}</span></span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{eventSummary(event)}</span></span><span className="flex shrink-0 items-center gap-2 text-[9px] text-muted-foreground"><span className="hidden items-center gap-1 sm:inline-flex"><Clock3 aria-hidden className="size-2.5" />{formatEventTiming(event)}</span>{inputTokens !== null || outputTokens !== null ? <span>{inputTokens ?? 0}/{outputTokens ?? 0}</span> : null}{event.attempt_no !== null ? <span>#{event.attempt_no}</span> : null}{selected ? <ChevronDown aria-hidden className="size-3 text-primary" /> : <ChevronRight aria-hidden className="size-3" />}</span></button>;
}

/** 右侧固定详情面板，按 DSH 的 Overview/Request/Result/Tool/Timing 分栏。 */
function TraceDetailPanel({ event }: Readonly<{ event: TraceEvent | null }>) {
  const [tab, setTab] = useState<DetailTab>("overview");
  useEffect(() => setTab("overview"), [event?.sequence_no]);
  const tabs: Array<{ id: DetailTab; label: string }> = [
    { id: "overview", label: "概述" }, { id: "request", label: "请求" },
    { id: "result", label: "结果" }, { id: "tool", label: "Tool" }, { id: "timing", label: "计时" },
  ];
  if (!event) return <aside className="min-h-[280px] border-l border-border/70 bg-card/45 p-3 text-[11px] text-muted-foreground lg:min-h-0 lg:sticky lg:top-0">选择左侧事件查看详情</aside>;
  const response = payloadValue(event, "response");
  const request = payloadValue(event, "payload");
  const inputTokens = eventTokenValue(event, "input");
  const outputTokens = eventTokenValue(event, "output");
  return <aside className="min-h-[280px] border-l border-border/70 bg-card/45 lg:sticky lg:top-0 lg:max-h-[calc(100vh-10rem)] lg:min-h-0"><div className="flex items-center justify-between border-b border-border/60 px-3 py-2"><div className="min-w-0"><p className="truncate text-xs font-medium">#{event.sequence_no} · {eventLabel(event.event_type)}</p><p className="truncate font-mono text-[9px] text-muted-foreground">{event.event_type}</p></div><span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">{event.turn_no === null ? "运行" : `T${event.turn_no}`}</span></div><div className="flex overflow-x-auto border-b border-border/60 px-1">{tabs.map((item) => <button className={`shrink-0 px-2 py-1.5 text-[10px] ${tab === item.id ? "border-b-2 border-primary font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`} key={item.id} onClick={() => setTab(item.id)} type="button">{item.label}</button>)}</div><div className="space-y-2 overflow-auto p-2.5">{tab === "overview" ? <><div className="grid grid-cols-2 gap-1.5 text-[10px]"><span className="rounded border border-border/60 bg-background/35 px-2 py-1.5">时间<br /><b className="font-normal text-foreground">{formatEventTiming(event)}</b></span><span className="rounded border border-border/60 bg-background/35 px-2 py-1.5">Token<br /><b className="font-normal text-foreground">{inputTokens ?? "未提供"} / {outputTokens ?? "未提供"}</b></span><span className="rounded border border-border/60 bg-background/35 px-2 py-1.5">轮次<br /><b className="font-normal text-foreground">{event.turn_no ?? "未提供"}</b></span><span className="rounded border border-border/60 bg-background/35 px-2 py-1.5">尝试<br /><b className="font-normal text-foreground">{event.attempt_no ?? "未提供"}</b></span></div><TraceJsonViewer label="事件摘要" value={event.payload} /></> : null}{tab === "request" ? <><TraceJsonViewer label="实际 Provider 请求（最终 Prompt / 配置）" value={request} /><TraceJsonViewer label="完整请求事件" value={event.payload} /></> : null}{tab === "result" ? <><TraceJsonViewer label="模型正文、Thinking 与 Tool Calls" value={response} /><TraceJsonViewer label="完整结果事件" value={event.payload} /></> : null}{tab === "tool" ? <><TraceJsonViewer label="Tool 原始输入" value={payloadValue(event, "arguments")} /><TraceJsonViewer label="Tool 原始输出" value={payloadValue(event, "result")} /></> : null}{tab === "timing" ? <><TraceJsonViewer label="时间字段" value={{ started_at: formatTraceTimestamp(event.started_at), finished_at: formatTraceTimestamp(event.finished_at), created_at: formatTraceTimestamp(event.created_at), duration_ms: event.started_at && event.finished_at ? Math.max(0, new Date(event.finished_at).getTime() - new Date(event.started_at).getTime()) : null }} /><TraceJsonViewer label="用量" value={{ input_tokens: inputTokens, output_tokens: outputTokens }} /></> : null}</div></aside>;
}

/** DSH 风格轨迹页：toolbar、时间概览、紧凑事件表和固定详情面板。 */
export function TraceTrajectoryView({ events, connectionState }: Readonly<{ events: readonly TraceEvent[]; connectionState: TraceConnectionState }>) {
  const [query, setQuery] = useState("");
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const filteredEvents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? events.filter((event) => JSON.stringify(event).toLowerCase().includes(normalized)) : events;
  }, [events, query]);
  const groups = useMemo(() => groupEventsByTurn(filteredEvents), [filteredEvents]);
  // 生命周期是独立的 run 分组，不应计入用户实际看到的模型/工具轮次。
  // 使用 key 判断而不是 groups.length - 1，兼容无生命周期事件和空轨迹。
  const turnCount = groups.filter((group) => group.key !== "run").length;
  const selectedEvent = events.find((event) => event.sequence_no === selectedSequence) ?? null;

  /** 新事件到达或搜索改变时，保持详情面板有一个可查看事件。 */
  useEffect(() => {
    if (filteredEvents.length === 0) {
      setSelectedSequence(null);
      return;
    }
    if (!filteredEvents.some((event) => event.sequence_no === selectedSequence)) setSelectedSequence(filteredEvents[0].sequence_no);
  }, [filteredEvents, selectedSequence]);

  /** 切换一个轮次分组的折叠状态。 */
  function toggleGroup(key: string): void {
    setCollapsed((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  return <section className="overflow-hidden rounded-lg border border-border/80 bg-card/70"><div className="flex h-9 items-center gap-1 border-b border-border/70 bg-card/80 px-2"><span className="px-2 text-[10px] font-medium text-foreground">Trajectory</span><span className="text-[10px] text-muted-foreground">{events.length} events</span><span className="mx-1 h-3.5 w-px bg-border" /><span className="hidden items-center gap-1 text-[10px] text-muted-foreground sm:inline-flex"><Clock3 aria-hidden className="size-3" />{turnCount} turns</span><span className="hidden text-[10px] text-muted-foreground md:inline">· 按时间顺序</span><span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">{connectionState === "live" || connectionState === "connecting" ? <Wifi aria-hidden className="size-3 text-primary" /> : <WifiOff aria-hidden className="size-3 text-chart-4" />}{connectionState === "live" ? "实时" : connectionState === "connecting" ? "连接中" : connectionState === "disconnected" ? "断线续传" : "已结束"}</span></div><div className="flex h-9 items-center gap-2 border-b border-border/60 bg-background/35 px-2.5"><label className="flex min-w-0 flex-1 items-center gap-1.5"><Search aria-hidden className="size-3 shrink-0 text-muted-foreground" /><input className="min-w-0 flex-1 bg-transparent text-[10px] outline-none placeholder:text-muted-foreground" onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Prompt、模型、Tool 或错误码" value={query} /></label><span className="shrink-0 text-[9px] text-muted-foreground">{filteredEvents.length}/{events.length}</span></div><div className="flex h-11 items-center gap-2 border-b border-border/60 bg-background/35 px-2.5"><div className="flex shrink-0 items-center gap-1 text-[9px] text-muted-foreground"><span>时间</span><span className="rounded bg-secondary px-1.5 py-0.5">{events.length ? formatEventTiming(events[0]) : "—"}</span></div><div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden rounded bg-secondary/45 px-1.5 py-2">{events.length ? events.map((event) => <button aria-label={`选择事件 ${event.sequence_no}`} className={`h-3 min-w-[3px] flex-1 rounded-sm ${eventTone(event.event_type)} ${selectedSequence === event.sequence_no ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : "opacity-65 hover:opacity-100"}`} key={event.sequence_no} onClick={() => setSelectedSequence(event.sequence_no)} type="button" />) : <span className="px-2 text-[10px] text-muted-foreground">暂无事件</span>}</div><span className="shrink-0 text-[9px] text-muted-foreground">{events.length ? formatEventTiming(events.at(-1)!) : "—"}</span></div><div className="grid min-h-[360px] lg:grid-cols-[minmax(0,1fr)_minmax(18rem,25rem)]"><div className="min-w-0 bg-background/20"><div className="flex h-8 items-center gap-3 border-b border-border/60 px-2.5 text-[9px] uppercase tracking-[0.08em] text-muted-foreground"><span className="w-5">#</span><span className="flex-1">事件 / 摘要</span><span>时间 · token · 尝试</span></div>{groups.length === 0 ? <div className="px-4 py-14 text-center text-xs text-muted-foreground">没有匹配的轨迹事件</div> : groups.map((group) => <section key={group.key}><button className="flex w-full items-center gap-1.5 border-b border-border/60 bg-secondary/25 px-2.5 py-1.5 text-left text-[10px] font-medium" onClick={() => toggleGroup(group.key)} type="button">{collapsed.has(group.key) ? <ChevronRight aria-hidden className="size-3 text-primary" /> : <ChevronDown aria-hidden className="size-3 text-primary" />}<span>{group.label}</span><span className="font-normal text-muted-foreground">{group.events.length}</span></button>{collapsed.has(group.key) ? null : group.events.map((event) => <TraceEventRow event={event} key={event.sequence_no} onSelect={() => setSelectedSequence(event.sequence_no)} selected={selectedSequence === event.sequence_no} />)}</section>)}</div><TraceDetailPanel event={selectedEvent} /></div></section>;
}
