/**
 * Agent 观测平台页面容器。
 *
 * 调用顺序：`ObservabilityRunsPage` 请求运行摘要列表；`ObservabilityRunDetailPage`
 * 请求摘要与历史事件后订阅 SSE；两者把网络状态、空状态、加载态和断线续传提示交给展示层。
 */

"use client";

import { Activity, AlertCircle, ArrowLeft, ChevronRight, CircleCheck, CircleX, Clock3, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { TraceTrajectoryView, type TraceConnectionState, type TraceEvent } from "./trace-trajectory-view";

interface TraceRunSummary {
  id: string; goal_id: string; goal_title: string; run_type: string; status: string;
  target_type: string; target_id: string; trace_id: string; requested_model_id: string | null;
  actual_model_profile: string | null; fallback_reason: string | null; input_tokens: number;
  output_tokens: number; estimated_cost_usd: string; retry_count: number; error_code: string | null;
  started_at: string | null; finished_at: string | null; created_at: string; updated_at: string;
  plan_title?: string | null;
  plan_node_title?: string | null;
}

interface TraceEventPage {
  items: TraceEvent[];
  next_cursor: number | null;
}

/** 解析 JSON 接口错误，保留用户可理解的服务端提示。 */
async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `观测接口请求失败（HTTP ${response.status}）。`);
  return body as T;
}

/** 在开发路由刚完成编译或网络短暂抖动时重试观测请求。 */
async function requestJsonWithRetry<T>(url: string, maxAttempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await requestJson<T>(url);
    } catch (requestError) {
      lastError = requestError;
      if (attempt === maxAttempts - 1) break;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("观测数据读取失败，请稍后重试。");
}

/** 按事件游标读取一次运行的全部轨迹，避免终态运行截断在首个 100 条事件。 */
async function requestAllTraceEvents(runId: string): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  let after: number | null = null;
  while (true) {
    const cursor: string = after === null ? "" : `&after=${after}`;
    const page: TraceEventPage = await requestJsonWithRetry<TraceEventPage>(`/api/v1/observability/runs/${runId}/events?limit=100${cursor}`);
    events.push(...page.items);
    if (page.next_cursor === null) return events;
    if (page.next_cursor <= (after ?? 0)) throw new Error("观测轨迹游标未向前推进。");
    after = page.next_cursor;
  }
}

/** 终态写入与运行状态更新分开提交时，短暂等待最后一条终态轨迹。 */
async function requestTraceEventsAfterTerminal(runId: string, status: string): Promise<TraceEvent[]> {
  const terminalEventType = status === "succeeded" ? "run.completed" : status === "failed" ? "run.failed" : null;
  let events: TraceEvent[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    events = await requestAllTraceEvents(runId);
    if (!terminalEventType || events.some((event) => event.event_type === terminalEventType)) return events;
    if (attempt < 3) await new Promise<void>((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
  }
  return events;
}

/** 将运行类型转换为界面标签。 */
function runTypeLabel(value: string): string {
  const labels: Record<string, string> = { assessment_generate: "前测生成", plan_generate: "路线生成", card_content_generate: "卡片内容", posttest_generate: "后测生成", adaptation: "路线调整" };
  return labels[value] ?? value;
}

/** 将运行状态转换为中文标签。 */
function statusLabel(value: string): string {
  return ({ queued: "排队中", running: "运行中", succeeded: "已完成", failed: "失败", cancelled: "已取消", expired: "已过期" } as Record<string, string>)[value] ?? value;
}

/** 为需要节点上下文的工作流生成可读内容节点标签。 */
function runNodeLabel(run: Pick<TraceRunSummary, "run_type" | "plan_node_title" | "target_id">): string | null {
  if (run.run_type !== "card_content_generate" && run.run_type !== "posttest_generate") return null;
  return run.plan_node_title ?? run.target_id;
}

/** 格式化列表中的相对可读时间。 */
function formatDate(value: string | null): string {
  if (!value) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/** 返回进入观测模块前的页面；没有可返回历史时使用安全回退地址。 */
function BackToPreviousButton({ fallbackHref }: Readonly<{ fallbackHref: string }>) {
  const router = useRouter();

  /** 优先回退浏览器历史，避免用户从节点进入观测后丢失上下文。 */
  function handleBack(): void {
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.push(fallbackHref);
  }

  return <button className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground" onClick={handleBack} type="button"><ArrowLeft aria-hidden className="size-3.5" />返回上次页面</button>;
}

/** 运行列表页：支持首屏加载、空状态、错误和游标加载更多。 */
export function ObservabilityRunsPage() {
  const [runs, setRuns] = useState<TraceRunSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 请求一页当前用户自己的观测运行。 */
  const loadRuns = useCallback(async (nextCursor: string | null, append: boolean): Promise<void> => {
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const query = nextCursor ? `?limit=20&cursor=${encodeURIComponent(nextCursor)}` : "?limit=20";
      const result = await requestJson<{ items: TraceRunSummary[]; next_cursor: string | null }>(`/api/v1/observability/runs${query}`);
      setRuns((current) => append ? [...current, ...result.items] : result.items);
      setCursor(result.next_cursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "观测数据读取失败，请稍后重试。");
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadRuns(null, false); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRuns]);

  return (
    <main className="relative mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6 sm:py-7">
      <div className="mb-3"><BackToPreviousButton fallbackHref="/goals" /></div>
      <header className="border-b border-border/70 pb-4">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] text-primary"><Activity aria-hidden className="size-3" />AGENT OBSERVABILITY</p><h1 className="mt-2 font-heading text-3xl font-medium tracking-tight">Agent 观测</h1><p className="mt-1 text-xs text-muted-foreground">按运行查看最终 Prompt、模型输出、Thinking、Tool 调用和重试时间线。</p></div><button aria-label="刷新观测运行" className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs hover:bg-secondary" disabled={loading} onClick={() => void loadRuns(null, false)} type="button"><RefreshCw aria-hidden className={loading ? "size-3 animate-spin" : "size-3"} />刷新</button></div>
      </header>
      {error ? <div className="mt-6 flex items-start gap-3 rounded-2xl border border-destructive/25 bg-destructive/5 p-4 text-sm text-destructive"><AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" /><div><p className="font-medium">无法读取观测运行</p><p className="mt-1">{error}</p></div></div> : null}
      {loading ? <LoadingRuns /> : null}
      {!loading && !error && runs.length === 0 ? <EmptyRuns /> : null}
      {!loading && runs.length > 0 ? <section className="mt-4 overflow-hidden rounded-lg border border-border/80 bg-card/70">{runs.map((run) => <RunListCard key={run.id} run={run} />)}{cursor ? <button className="mx-auto my-3 flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs hover:bg-secondary" disabled={loadingMore} onClick={() => void loadRuns(cursor, true)} type="button">{loadingMore ? <LoaderCircle aria-hidden className="size-3 animate-spin" /> : <ChevronRight aria-hidden className="size-3" />}加载更多</button> : <p className="py-3 text-center text-[11px] text-muted-foreground">已加载全部观测运行</p>}</section> : null}
    </main>
  );
}

/** 单条观测运行卡片，作为列表到 DSH 风格轨迹页的入口。 */
function RunListCard({ run }: Readonly<{ run: TraceRunSummary }>) {
  const statusClass = run.status === "succeeded" ? "text-primary bg-primary/10 border-primary/20" : run.status === "failed" ? "text-destructive bg-destructive/10 border-destructive/20" : "text-foreground bg-secondary border-border";
  const nodeLabel = runNodeLabel(run);
  return <Link className="group grid grid-cols-[minmax(0,1.7fr)_minmax(10rem,1fr)_auto] items-center gap-3 border-b border-border/60 px-3 py-2.5 transition-colors last:border-b-0 hover:bg-secondary/35 sm:grid-cols-[minmax(0,1.8fr)_minmax(13rem,1fr)_auto]" href={`/observability/${run.id}`}><div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-[10px] font-medium tracking-[0.08em] text-primary">{runTypeLabel(run.run_type)}</span><span className="truncate text-sm font-medium">{run.goal_title}</span></div><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{run.id}</p></div><div className="min-w-0 text-[11px] text-muted-foreground"><span className="block truncate">{nodeLabel ? `内容节点 · ${nodeLabel}` : `创建于 ${formatDate(run.created_at)}`}</span><span className="mt-1 block truncate">{nodeLabel ? formatDate(run.created_at) : `输入 ${run.input_tokens.toLocaleString()} · 输出 ${run.output_tokens.toLocaleString()} · 重试 ${run.retry_count}`}</span></div><div className="flex flex-col items-end gap-1"><span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusClass}`}>{run.status === "succeeded" ? <CircleCheck aria-hidden className="size-3" /> : run.status === "failed" ? <CircleX aria-hidden className="size-3" /> : <Clock3 aria-hidden className="size-3" />}{statusLabel(run.status)}</span><span className="text-[10px] text-muted-foreground">{run.input_tokens.toLocaleString()} in · {run.output_tokens.toLocaleString()} out · {run.retry_count} retry</span></div></Link>;
}

/** 运行列表加载骨架。 */
function LoadingRuns() { return <div className="mt-6 space-y-3" aria-label="正在加载观测运行"><div className="h-40 animate-pulse rounded-[1.25rem] bg-secondary/70" /><div className="h-40 animate-pulse rounded-[1.25rem] bg-secondary/70" /></div>; }

/** 没有任何观测运行时的引导空状态。 */
function EmptyRuns() { return <div className="mt-6 rounded-[1.25rem] border border-dashed border-primary/25 bg-card/70 px-6 py-16 text-center"><Activity aria-hidden className="mx-auto size-8 text-primary" /><h2 className="mt-5 font-heading text-2xl font-medium">还没有观测运行</h2><p className="mx-auto mt-3 max-w-md text-sm leading-7 text-muted-foreground">完成一次前测、路线或卡片生成后，这里会出现可回放的完整 Agent 轨迹。</p><Link className="mt-7 inline-flex h-11 items-center rounded-xl bg-primary px-5 text-sm text-primary-foreground hover:opacity-90" href="/goals">查看我的目标</Link></div>; }

/** 运行详情页：加载摘要和历史事件，并使用 SSE 断线自动续传。 */
export function ObservabilityRunDetailPage({ runId }: Readonly<{ runId: string }>) {
  const [run, setRun] = useState<TraceRunSummary | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<TraceConnectionState>("connecting");
  const lastSequence = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const loadGeneration = useRef(0);
  const loadedRunId = useRef<string | null>(null);

  /** 读取运行摘要与首批历史轨迹。 */
  const loadInitial = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current;
    if (loadedRunId.current !== runId) {
      loadedRunId.current = null;
      setRun(null);
      setEvents([]);
      lastSequence.current = 0;
    }
    setLoading(true); setError(null); setEventsError(null);
    try {
      const [summaryResult, eventsResult] = await Promise.allSettled([
        requestJson<TraceRunSummary>(`/api/v1/observability/runs/${runId}`),
        requestAllTraceEvents(runId),
      ]);
      if (generation !== loadGeneration.current) return;
      if (summaryResult.status === "rejected") {
        throw summaryResult.reason;
      }

      const summary = summaryResult.value;
      let loadedEvents = eventsResult.status === "fulfilled" ? eventsResult.value : [];
      let terminalReloadError: unknown = null;
      if (eventsResult.status === "fulfilled" && ["succeeded", "failed"].includes(summary.status)) {
        try {
          loadedEvents = await requestTraceEventsAfterTerminal(runId, summary.status);
        } catch (reloadError) {
          terminalReloadError = reloadError;
        }
      }
      if (generation !== loadGeneration.current) return;
      setRun(summary);
      loadedRunId.current = summary.id;
      if (eventsResult.status === "fulfilled") {
        setEvents(loadedEvents);
        lastSequence.current = loadedEvents.at(-1)?.sequence_no ?? 0;
        if (terminalReloadError instanceof Error) {
          setEventsError(`终态轨迹补读失败：${terminalReloadError.message}`);
        } else if (summary.status === "succeeded" && !loadedEvents.some((event) => event.event_type === "run.completed")) {
          setEventsError("运行已完成，但最后的终态轨迹仍在写入，请稍后重试。");
        } else if (summary.status === "failed" && !loadedEvents.some((event) => event.event_type === "run.failed")) {
          setEventsError("运行已失败，但最后的终态轨迹仍在写入，请稍后重试。");
        }
      } else {
        setEventsError(eventsResult.reason instanceof Error ? eventsResult.reason.message : "观测轨迹暂时无法加载，请稍后重试。");
      }
      setConnectionState(["succeeded", "failed", "cancelled", "expired"].includes(summary.status) ? "closed" : "connecting");
    } catch (loadError) {
      if (generation === loadGeneration.current) setError(loadError instanceof Error ? loadError.message : "观测详情读取失败，请稍后重试。");
    }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [runId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadInitial(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadInitial]);

  useEffect(() => {
    if (loading || !run || ["succeeded", "failed", "cancelled", "expired"].includes(run.status)) return;
    let active = true;
    let source: EventSource | null = null;
    let retryDelay = 1_000;

    /** 在 SSE 断开后检查运行状态，避免已取消运行持续重连。 */
    function scheduleReconnect(): void {
      if (!active) return;
      setConnectionState("disconnected");
      reconnectTimer.current = window.setTimeout(connect, retryDelay);
      retryDelay = Math.min(10_000, retryDelay * 2);
    }

    /** 连接 SSE，并把重复或乱序事件丢弃后追加到轨迹。 */
    function connect(): void {
      if (!active) return;
      setConnectionState("connecting");
      source = new EventSource(`/api/v1/observability/runs/${runId}/events/stream?after=${lastSequence.current}`);
      source.addEventListener("trace", (rawEvent) => {
        try {
          const event = JSON.parse((rawEvent as MessageEvent<string>).data) as TraceEvent;
          if (!active || event.sequence_no <= lastSequence.current) return;
          lastSequence.current = event.sequence_no;
          setEvents((current) => [...current, event]);
          setEventsError(null);
          setConnectionState("live"); retryDelay = 1_000;
          if (event.event_type === "run.completed" || event.event_type === "run.failed") {
            setConnectionState("closed");
            active = false;
            source?.close();
          }
        } catch { /* 单条坏事件不影响后续续传。 */ }
      });
      source.onopen = () => { setConnectionState("live"); retryDelay = 1_000; };
      source.onerror = () => {
        source?.close(); source = null;
        if (!active) return;
        void requestJson<TraceRunSummary>(`/api/v1/observability/runs/${runId}`)
          .then((latestRun) => {
            if (!active) return;
            if (["succeeded", "failed", "cancelled", "expired"].includes(latestRun.status)) {
              active = false;
              void loadInitial();
              return;
            }
            scheduleReconnect();
          })
          .catch(() => scheduleReconnect());
      };
    }
    connect();
    return () => { active = false; source?.close(); if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current); };
  }, [loadInitial, loading, run, runId]);

  if (loading) return <main className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6 sm:py-7"><LoadingDetail /></main>;
  if (error || !run) return <main className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6 sm:py-7"><div className="rounded-lg border border-destructive/25 bg-destructive/5 p-5 text-sm text-destructive"><AlertCircle aria-hidden className="mb-3 size-4" /><p className="font-medium">无法加载观测详情</p><p className="mt-2">{error ?? "任务不存在或你无权访问。"}</p><Link className="mt-4 inline-flex items-center gap-2 underline" href="/observability"><ArrowLeft aria-hidden className="size-4" />返回观测列表</Link></div></main>;
  const resumeSequence = events.at(-1)?.sequence_no ?? 0;
  const nodeLabel = runNodeLabel(run);
  return <main className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6 sm:py-7"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><BackToPreviousButton fallbackHref="/observability" /><Link className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" href="/observability">观测列表</Link></div><button className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] hover:bg-secondary" onClick={() => void loadInitial()} type="button"><RotateCcw aria-hidden className="size-3" />重新读取</button></div><header className="mt-4 border-b border-border/70 pb-3"><div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="text-[10px] font-medium tracking-[0.12em] text-primary">{runTypeLabel(run.run_type)}</span><h1 className="truncate font-heading text-xl font-medium tracking-tight">{run.goal_title}</h1><span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">{statusLabel(run.status)}</span></div><div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground"><span className="font-mono">runId · {run.id}</span>{nodeLabel ? <span className="truncate text-primary">内容节点 · {nodeLabel}</span> : null}<span>开始 {formatDate(run.started_at)}</span><span>结束 {formatDate(run.finished_at)}</span><span>{run.input_tokens.toLocaleString()} in · {run.output_tokens.toLocaleString()} out · {run.retry_count} retry</span></div></header>{connectionState === "disconnected" ? <div className="mt-3 flex items-center gap-2 rounded-md border border-chart-4/30 bg-chart-4/10 px-3 py-2 text-[11px] text-foreground"><WifiOffIcon />实时连接已断开，正在从序号 {resumeSequence + 1} 自动续传。</div> : null}{eventsError ? <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-chart-4/30 bg-chart-4/10 px-3 py-2 text-[11px] text-foreground"><span>观测轨迹暂时无法加载：{eventsError}</span><button className="shrink-0 underline" onClick={() => void loadInitial()} type="button">重试</button></div> : null}<div className="mt-3"><TraceTrajectoryView connectionState={connectionState} events={events} /></div></main>;
}

/** 详情页加载骨架，保持时间线区域尺寸稳定。 */
function LoadingDetail() { return <div aria-label="正在加载观测详情"><div className="h-8 w-40 animate-pulse rounded bg-secondary/70" /><div className="mt-6 h-48 animate-pulse rounded-[1.5rem] bg-secondary/70" /><div className="mt-6 h-96 animate-pulse rounded-[1.5rem] bg-secondary/70" /></div>; }

/** 断线提示图标。 */
function WifiOffIcon() { return <span className="inline-flex size-4 items-center justify-center"><CircleX aria-hidden className="size-4 text-chart-4" /></span>; }
