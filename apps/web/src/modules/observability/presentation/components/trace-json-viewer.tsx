/**
 * Agent 观测 JSON 查看器。
 *
 * 调用顺序：`TraceJsonViewer` 先安全序列化 JSON，再由 `JsonBlock` 提供折叠、复制和滚动展示；
 * 超过长文本阈值时默认折叠，避免完整 Prompt/Tool 输出一次性撑开页面。
 */

"use client";

import { Check, Copy, FileJson } from "lucide-react";
import { useState } from "react";

const LONG_JSON_LENGTH = 6_000;

/** 将任意 JSON 值格式化为可复制文本，序列化失败时保留可读回退。 */
function formatJson(value: unknown): string {
  try {
    const formatted = JSON.stringify(value, null, 2);
    return formatted === undefined ? String(value) : formatted;
  } catch {
    return "[无法序列化的观测内容]";
  }
}

/** 渲染一段带折叠与复制能力的长 JSON。 */
function JsonBlock({ value, label }: Readonly<{ value: unknown; label: string }>) {
  const [copied, setCopied] = useState(false);
  const text = formatJson(value);
  const isLong = text.length > LONG_JSON_LENGTH;

  /** 复制完整 JSON，不截断用户实际查看的数据。 */
  async function copyJson(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <details className="group rounded-xl border border-border/80 bg-background/60" open={!isLong}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span className="inline-flex min-w-0 items-center gap-2"><FileJson aria-hidden className="size-3.5 shrink-0 text-primary" /><span className="truncate">{label}</span><span className="text-[10px] opacity-70">{text.length.toLocaleString()} 字符</span></span>
        <button aria-label={`复制${label}`} className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={(event) => { event.preventDefault(); void copyJson(); }} type="button">
          {copied ? <Check aria-hidden className="size-3" /> : <Copy aria-hidden className="size-3" />}
          {copied ? "已复制" : "复制"}
        </button>
      </summary>
      <pre className="max-h-[32rem] overflow-auto border-t border-border/70 px-3 py-3 font-mono text-[11px] leading-5 text-foreground/85">{text}</pre>
    </details>
  );
}

/** JSON 详情面板；空值明确显示“未提供”。 */
export function TraceJsonViewer({ value, label }: Readonly<{ value: unknown; label: string }>) {
  if (value === null || value === undefined) {
    return <div className="rounded-xl border border-dashed border-border bg-background/45 px-3 py-3 text-xs text-muted-foreground">{label}：未提供</div>;
  }
  return <JsonBlock label={label} value={value} />;
}
