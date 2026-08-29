/**
 * 学习路线展示组件。
 *
 * 组件：
 * - LearningPlanView：读取并展示书籍章节式学习计划、章节目标、时长和前置关系。
 */

"use client";

import { AlertCircle, ArrowLeft, ArrowRight, BookOpen, Clock3, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";

import {
  getLearningPlan,
  PlanningApiError,
  type LearningPlan,
  type LearningPlanNode,
} from "../api/planning-client";

export function LearningPlanView({ planId }: Readonly<{ planId: string }>) {
  const [plan, setPlan] = useState<LearningPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getLearningPlan(planId)
      .then((nextPlan) => {
        if (active) setPlan(nextPlan);
      })
      .catch((requestError: unknown) => {
        if (active) {
          setError(requestError instanceof PlanningApiError ? requestError.message : "学习计划暂时无法读取，请稍后重试。");
        }
      });
    return () => {
      active = false;
    };
  }, [planId]);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-5xl px-6 py-12 sm:px-10 sm:py-16">
        <Alert className="rounded-none border-[#d9b4a9] bg-[#fff8f5] text-[#8b3f35]" variant="destructive">
          <AlertCircle aria-hidden className="size-4" />
          <AlertTitle className="text-[#8b3f35]">无法读取学习计划</AlertTitle>
          <AlertDescription className="mt-1 text-[#8b3f35]">{error}</AlertDescription>
        </Alert>
        <Button asChild className="mt-6 rounded-none" variant="outline">
          <Link href="/goals"><ArrowLeft aria-hidden className="size-4" />返回目标列表</Link>
        </Button>
      </main>
    );
  }

  if (!plan) {
    return <div className="grid min-h-96 place-items-center"><LoaderCircle aria-hidden className="size-5 animate-spin text-primary" /></div>;
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10 sm:px-10 sm:py-14">
      <Button asChild className="rounded-none" variant="ghost">
        <Link href={"/goals/" + plan.goal_id}><ArrowLeft aria-hidden className="size-4" />返回学习目标</Link>
      </Button>
      <header className="mt-7 border border-border border-l-2 border-l-primary bg-card p-6 sm:p-9">
        <div className="flex flex-wrap items-center gap-3 text-xs tracking-[0.16em] text-primary">
          <span className="inline-flex items-center gap-2"><BookOpen aria-hidden className="size-4" />学习路线</span>
          <span className="text-muted-foreground">第 {plan.version} 版</span>
          <span className="text-muted-foreground">{formatStatus(plan.status)}</span>
        </div>
        <h1 className="mt-4 font-heading text-4xl font-normal tracking-tight">{plan.title}</h1>
        {plan.summary ? <p className="mt-5 max-w-3xl text-sm leading-8 text-muted-foreground">{plan.summary}</p> : null}
        <p className="mt-5 text-xs text-muted-foreground">基于画像版本 {plan.profile_version} 生成 · 共 {plan.nodes.length} 章</p>
      </header>
      <section className="mt-8">
        <div className="mb-4 flex items-end justify-between">
          <div><p className="text-xs tracking-[0.16em] text-primary">TABLE OF CONTENTS</p><h2 className="mt-2 font-heading text-2xl font-normal">章节目录</h2></div>
          <p className="text-sm text-muted-foreground">可任选章节开始学习</p>
        </div>
        <div className="grid gap-4">{plan.nodes.map((node) => <ChapterCard key={node.id} node={node} allNodes={plan.nodes} />)}</div>
      </section>
    </main>
  );
}

function ChapterCard({ node, allNodes }: Readonly<{ node: LearningPlanNode; allNodes: LearningPlanNode[] }>) {
  const prerequisites = node.prerequisite_node_ids
    .map((id) => allNodes.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is LearningPlanNode => Boolean(candidate));
  const prerequisiteLabel = prerequisites.length > 0
    ? prerequisites.map((prerequisite) => "第 " + String(prerequisite.ordinal) + " 章 · " + prerequisite.title + "（" + formatStatus(prerequisite.status) + "）").join("、")
    : "无前置章节";
  return (
    <Link
      className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      href={"/plan-nodes/" + node.id}
    >
      <article className="scroll-mt-6 border border-border bg-card p-5 transition-colors hover:border-primary/60 hover:bg-primary/[0.02] sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex size-12 shrink-0 items-center justify-center border border-primary/40 text-sm font-medium text-primary">{String(node.ordinal).padStart(2, "0")}</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <h3 className="font-heading text-2xl font-normal">{node.title}</h3>
              <span className="text-xs text-muted-foreground">{formatStatus(node.status)}</span>
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-primary">进入章节<ArrowRight aria-hidden className="size-3" /></span>
            </div>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">{node.node_brief}</p>
            <div className="mt-5 grid gap-4 border-t border-border pt-4 text-sm sm:grid-cols-2">
              <div><p className="text-xs text-muted-foreground">学习目标</p><p className="mt-1 leading-7">{node.learning_objective}</p></div>
              <div><p className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Clock3 aria-hidden className="size-3" />预计时长</p><p className="mt-1">{node.estimated_minutes} 分钟 · 难度 {node.difficulty}/5</p></div>
            </div>
            <div className="mt-4 grid gap-4 border-t border-border pt-4 text-sm sm:grid-cols-2">
              <div><p className="text-xs text-muted-foreground">前置章节</p><p className="mt-1">{prerequisiteLabel}</p><p className="mt-2 text-xs text-muted-foreground">完成状态仅作学习记录，不限制本章学习。</p></div>
              <div><p className="text-xs text-muted-foreground">完成标准</p><ul className="mt-1 list-disc space-y-1 pl-5">{node.completion_criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></div>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">内容状态：{formatStatus(node.content_status)} · {node.status === "completed" ? "已标记完成" : "未标记完成"}</p>
          </div>
        </div>
      </article>
    </Link>
  );
}
function formatStatus(value: string): string {
  const labels: Record<string, string> = {
    active: "进行中", available: "可学习", completed: "已完成", generating: "生成中",
    not_requested: "未请求", ready: "已准备", in_progress: "学习中", needs_review: "需复习",
    superseded: "历史版本",
  };
  return labels[value] ?? value;
}