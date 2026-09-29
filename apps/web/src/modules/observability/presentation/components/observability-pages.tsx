/**
 * Agent 观测平台页面容器。
 *
 * 调用顺序：`ObservabilityRunsPage` 请求运行摘要列表；`ObservabilityRunDetailPage`
 * 请求摘要与历史事件后订阅 SSE；两者把网络状态、空状态、加载态和断线续传提示交给展示层。
 */

"use client";

import { Activity, AlertCircle, ArrowLeft, ChevronRight, CircleCheck, CircleX, Clock3, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { TraceTrajectoryView, type TraceConnectionState, type TraceEvent } from "./trace-trajectory-view";

interface TraceRunSummary {
  id: string; goal_id: string; goal_title: string; run_type: string; status: string;
  target_type: string; target_id: string; trace_id: string; requested_model_id: string | null;
  actual_model_profile: string | null; fallback_reason: string | null; input_tokens: number;
  output_tokens: number; estimated_cost_usd: string; retry_count: number; error_code: string | null;
  started_at: string | null; finished_at: string | null; created_at: string; updated_at: string;
  plan_title?: string | null;
}

/** 解析 JSON 接口错误，保留用户可理解的服务端提示。 */
async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? "观测数据读取失败，请稍后重试。");
  return body as T;
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

/** 格式化列表中的相对可读时间。 */
function formatDate(value: string | null): string {
  if (!value) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
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
    <main className="relative mx-auto w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10">
      <header className="rounded-[1.5rem] border border-border/80 bg-card/80 p-5 shadow-[0_24px_70px_-46px_rgba(23,53,58,0.5)] backdrop-blur sm:p-8">
        <p className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-[0.14em] text-primary"><Activity aria-hidden className="size-3.5" />AGENT OBSERVABILITY</p>
        <div className="mt-5 flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><h1 className="font-heading text-4xl font-medium tracking-tight sm:text-5xl">Agent 观测</h1><p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">查看你自己的 AgentRun 轨迹、最终 Prompt、模型输出、Thinking、Tool 调用和重试时间线。</p></div><button aria-label="刷新观测运行" className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 text-sm hover:bg-secondary" disabled={loading} onClick={() => void loadRuns(null, false)} type="button"><RefreshCw aria-hidden className={loading ? "size-4 animate-spin" : "size-4"} />刷新</button></div>
      </header>
      {error ? <div className="mt-6 flex items-start gap-3 rounded-2xl border border-destructive/25 bg-destructive/5 p-4 text-sm text-destructive"><AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" /><div><p className="font-medium">无法读取观测运行</p><p className="mt-1">{error}</p></div></div> : null}
      {loading ? <LoadingRuns /> : null}
      {!loading && !error && runs.length === 0 ? <EmptyRuns /> : null}
      {!loading && runs.length > 0 ? <section className="mt-6 space-y-3">{runs.map((run) => <RunListCard key={run.id} run={run} />)}{cursor ? <button className="mx-auto flex h-11 items-center gap-2 rounded-xl border border-border bg-card px-5 text-sm hover:bg-secondary" disabled={loadingMore} onClick={() => void loadRuns(cursor, true)} type="button">{loadingMore ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <ChevronRight aria-hidden className="size-4" />}加载更多</button> : <p className="py-4 text-center text-xs text-muted-foreground">已加载全部观测运行</p>}</section> : null}
    </main>
  );
}

/** 单条观测运行卡片，作为列表到 DSH 风格轨迹页的入口。 */
function RunListCard({ run }: Readonly<{ run: TraceRunSummary }>) {
  const statusClass = run.status === "succeeded" ? "text-primary bg-primary/10 border-primary/20" : run.status === "failed" ? "text-destructive bg-destructive/10 border-destructive/20" : "text-foreground bg-secondary border-border";
  return <Link className="group block rounded-[1.25rem] border border-border/80 bg-card/80 p-5 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] transition-all hover:-translate-y-0.5 hover:border-primary/35 sm:p-6" href={`/observability/${run.id}`}><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="text-xs font-medium tracking-[0.14em] text-primary">{runTypeLabel(run.run_type)}</p><h2 className="mt-2 truncate font-heading text-2xl font-medium tracking-tight">{run.goal_title}</h2><p className="mt-2 text-xs text-muted-foreground">{run.id}</p></div><span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass}`}>{run.status === "succeeded" ? <CircleCheck aria-hidden className="size-3.5" /> : run.status === "failed" ? <CircleX aria-hidden className="size-3.5" /> : <Clock3 aria-hidden className="size-3.5" />}{statusLabel(run.status)}</span></div><div className="mt-5 grid gap-3 rounded-2xl bg-secondary/50 p-4 text-xs text-muted-foreground sm:grid-cols-4"><span>创建于 {formatDate(run.created_at)}</span><span>输入 {run.input_tokens.toLocaleString()} tokens</span><span>输出 {run.output_tokens.toLocaleString()} tokens</span><span>{run.retry_count} 次重试</span></div></Link>;
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
  const [connectionState, setConnectionState] = useState<TraceConnectionState>("connecting");
  const lastSequence = useRef(0);
  const reconnectTimer = useRef<number | null>(null);

  /** 读取运行摘要与首批历史轨迹。 */
  const loadInitial = useCallback(async (): Promise<void> => {
    setLoading(true); setError(null);
    try {
      const [summary, page] = await Promise.all([
        requestJson<TraceRunSummary>(`/api/v1/observability/runs/${runId}`),
        requestJson<{ items: TraceEvent[]; next_cursor: number | null }>(`/api/v1/observability/runs/${runId}/events?limit=100`),
      ]);
      setRun(summary); setEvents(page.items); lastSequence.current = page.items.at(-1)?.sequence_no ?? 0;
      setConnectionState(["succeeded", "failed", "cancelled", "expired"].includes(summary.status) ? "closed" : "connecting");
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "观测详情读取失败，请稍后重试。"); }
    finally { setLoading(false); }
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
        setConnectionState("disconnected");
        reconnectTimer.current = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(10_000, retryDelay * 2);
      };
    }
    connect();
    return () => { active = false; source?.close(); if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current); };
  }, [loading, run, runId]);

  if (loading) return <main className="mx-auto w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10"><LoadingDetail /></main>;
  if (error || !run) return <main className="mx-auto w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10"><div className="rounded-2xl border border-destructive/25 bg-destructive/5 p-6 text-sm text-destructive"><AlertCircle aria-hidden className="mb-3 size-5" /><p className="font-medium">无法加载观测详情</p><p className="mt-2">{error ?? "任务不存在或你无权访问。"}</p><Link className="mt-5 inline-flex items-center gap-2 underline" href="/observability"><ArrowLeft aria-hidden className="size-4" />返回观测列表</Link></div></main>;
  const resumeSequence = events.at(-1)?.sequence_no ?? 0;
  return <main className="mx-auto w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10"><div className="flex flex-wrap items-center justify-between gap-3"><Link className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground" href="/observability"><ArrowLeft aria-hidden className="size-4" />返回观测列表</Link><button className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs hover:bg-secondary" onClick={() => void loadInitial()} type="button"><RotateCcw aria-hidden className="size-3.5" />重新读取</button></div><header className="mt-5 rounded-[1.5rem] border border-border/80 bg-card/80 p-5 shadow-[0_24px_70px_-46px_rgba(23,53,58,0.5)] sm:p-8"><div className="flex flex-wrap items-start justify-between gap-5"><div><p className="text-xs font-medium tracking-[0.14em] text-primary">{runTypeLabel(run.run_type)}</p><h1 className="mt-3 font-heading text-3xl font-medium tracking-tight sm:text-4xl">{run.goal_title}</h1><p className="mt-2 break-all text-xs text-muted-foreground">runId · {run.id}</p></div><span className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">{statusLabel(run.status)}</span></div><div className="mt-6 grid gap-3 text-xs text-muted-foreground sm:grid-cols-4"><span>开始 {formatDate(run.started_at)}</span><span>结束 {formatDate(run.finished_at)}</span><span>输入 {run.input_tokens.toLocaleString()} tokens</span><span>输出 {run.output_tokens.toLocaleString()} tokens</span></div></header>{connectionState === "disconnected" ? <div className="mt-4 flex items-center gap-2 rounded-xl border border-chart-4/30 bg-chart-4/10 px-4 py-3 text-xs text-foreground"><WifiOffIcon />实时连接已断开，正在从序号 {resumeSequence + 1} 自动续传。</div> : null}<div className="mt-6"><TraceTrajectoryView connectionState={connectionState} events={events} /></div></main>;
}

/** 详情页加载骨架，保持时间线区域尺寸稳定。 */
function LoadingDetail() { return <div aria-label="正在加载观测详情"><div className="h-8 w-40 animate-pulse rounded bg-secondary/70" /><div className="mt-6 h-48 animate-pulse rounded-[1.5rem] bg-secondary/70" /><div className="mt-6 h-96 animate-pulse rounded-[1.5rem] bg-secondary/70" /></div>; }

/** 断线提示图标。 */
function WifiOffIcon() { return <span className="inline-flex size-4 items-center justify-center"><CircleX aria-hidden className="size-4 text-chart-4" /></span>; }
