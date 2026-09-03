/**
 * 学习路线展示组件。
 *
 * 组件与函数：
 * - LearningPlanView：读取并展示学习路线、摘要与章节目录。
 * - ChapterCard：将单个章节呈现为纵向学习路径中的可进入节点。
 * - getNodeStatusPresentation：将既有章节状态转换为视觉状态标签。
 * - formatStatus：转换计划、章节和内容状态文案。
 */

"use client";

import { AlertCircle, ArrowLeft, ArrowRight, BookOpen, CheckCircle2, Clock3, LoaderCircle } from "lucide-react";
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
      <main className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10">
        <Alert className="rounded-2xl border-destructive/25 bg-destructive/5 text-destructive" variant="destructive">
          <AlertCircle aria-hidden className="size-4" />
          <AlertTitle className="text-destructive">无法读取学习计划</AlertTitle>
          <AlertDescription className="mt-1 text-destructive">{error}</AlertDescription>
        </Alert>
        <Button asChild className="mt-6 h-11 rounded-xl px-5" variant="outline">
          <Link href="/goals"><ArrowLeft aria-hidden className="size-4" />返回目标列表</Link>
        </Button>
      </main>
    );
  }

  if (!plan) {
    return <LoadingState />;
  }

  return (
    <main className="relative mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="lc-float absolute -top-12 right-[12%] size-72 rounded-full bg-primary/[0.08] blur-3xl" />
        <div className="lc-float-slow absolute bottom-0 left-0 size-52 rounded-full bg-chart-4/[0.1] blur-3xl" />
      </div>
      <div className="relative">
        <Button asChild className="h-10 rounded-xl px-3 text-muted-foreground hover:bg-card" variant="ghost">
          <Link href={'/goals/' + plan.goal_id}><ArrowLeft aria-hidden className="size-4" />返回学习目标</Link>
        </Button>

        <header className="mt-5 rounded-[1.5rem] border border-border/80 bg-card/85 p-5 shadow-[0_24px_70px_-46px_rgba(23,53,58,0.5)] backdrop-blur sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-[0.14em] text-primary">
                <BookOpen aria-hidden className="size-3.5" />
                LEARNING MAP
              </p>
              <h1 className="mt-5 font-heading text-4xl font-medium tracking-tight sm:text-5xl">{plan.title}</h1>
              {plan.summary ? <p className="mt-4 max-w-3xl text-sm leading-8 text-muted-foreground">{plan.summary}</p> : null}
            </div>
            <PlanStatusBadge status={plan.status} />
          </div>
          <div className="mt-7 flex flex-wrap gap-2 border-t border-border/80 pt-5 text-xs text-muted-foreground">
            <span className="rounded-full bg-secondary px-3 py-1.5">第 {plan.version} 版路线</span>
            <span className="rounded-full bg-secondary px-3 py-1.5">基于画像版本 {plan.profile_version}</span>
            <span className="rounded-full bg-secondary px-3 py-1.5">共 {plan.nodes.length} 章</span>
          </div>
        </header>

        <section className="mt-8">
          <div className="flex flex-col gap-3 px-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-medium tracking-[0.16em] text-primary">YOUR LEARNING PATH</p>
              <h2 className="mt-2 font-heading text-2xl font-medium">从这里继续</h2>
            </div>
            <p className="text-sm text-muted-foreground">可任选章节开始学习</p>
          </div>
          <div className="mt-5 space-y-4">
            {plan.nodes.map((node, index) => (
              <ChapterCard allNodes={plan.nodes} isLast={index === plan.nodes.length - 1} key={node.id} node={node} />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function ChapterCard({ node, allNodes, isLast }: Readonly<{ node: LearningPlanNode; allNodes: LearningPlanNode[]; isLast: boolean }>) {
  const prerequisites = node.prerequisite_node_ids
    .map((id) => allNodes.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is LearningPlanNode => Boolean(candidate));
  const prerequisiteLabel = prerequisites.length > 0
    ? prerequisites.map((prerequisite) => "第 " + String(prerequisite.ordinal) + " 章 · " + prerequisite.title + "（" + formatStatus(prerequisite.status) + "）").join("、")
    : "无前置章节";
  const presentation = getNodeStatusPresentation(node.status);

  return (
    <Link className="group relative block scroll-mt-6 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50" href={'/plan-nodes/' + node.id}>
      {!isLast ? <span aria-hidden className="absolute top-16 bottom-[-1rem] left-11 z-0 w-px bg-border/90 sm:left-12" /> : null}
      <article className="relative z-10 rounded-[1.25rem] border border-border/80 bg-card/85 p-5 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-[0_24px_55px_-38px_rgba(36,122,128,0.38)] sm:p-6">
        <div className="flex gap-4 sm:gap-5">
          <span className={`grid size-12 shrink-0 place-items-center rounded-2xl border text-sm font-medium shadow-sm ${presentation.markerClass}`}>
            {node.status === "completed" ? <CheckCircle2 aria-hidden className="size-5" /> : String(node.ordinal).padStart(2, "0")}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h3 className="font-heading text-2xl font-medium tracking-tight">{node.title}</h3>
              <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${presentation.badgeClass}`}>{presentation.label}</span>
              <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary transition-transform group-hover:translate-x-0.5">进入章节<ArrowRight aria-hidden className="size-3.5" /></span>
            </div>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">{node.node_brief}</p>

            <div className="mt-5 grid gap-3 rounded-2xl bg-secondary/55 p-4 text-sm sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium text-muted-foreground">学习目标</p>
                <p className="mt-2 leading-7">{node.learning_objective}</p>
              </div>
              <div className="sm:border-l sm:border-border/80 sm:pl-4">
                <p className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Clock3 aria-hidden className="size-3.5 text-primary" />预计投入</p>
                <p className="mt-2">{node.estimated_minutes} 分钟 · 难度 {node.difficulty}/5</p>
              </div>
            </div>

            <div className="mt-4 grid gap-4 border-t border-border/80 pt-4 text-sm lg:grid-cols-2">
              <div>
                <p className="text-xs font-medium text-muted-foreground">前置章节</p>
                <p className="mt-2 leading-6">{prerequisiteLabel}</p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">完成状态仅作学习记录，不限制本章学习。</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">完成标准</p>
                <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-6">{node.completion_criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
              </div>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">内容状态：{formatStatus(node.content_status)} · {node.status === "completed" ? "已标记完成" : "未标记完成"}</p>
          </div>
        </div>
      </article>
    </Link>
  );
}

function PlanStatusBadge({ status }: Readonly<{ status: string }>) {
  const presentation = getNodeStatusPresentation(status);
  return <span className={`w-fit shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium ${presentation.badgeClass}`}>{presentation.label}</span>;
}

function getNodeStatusPresentation(status: string): { label: string; markerClass: string; badgeClass: string } {
  const presentations: Record<string, { label: string; markerClass: string; badgeClass: string }> = {
    active: {
      label: "进行中",
      markerClass: "border-primary bg-primary text-primary-foreground",
      badgeClass: "border-primary bg-primary text-primary-foreground",
    },
    available: {
      label: "可学习",
      markerClass: "border-primary/25 bg-primary/10 text-primary",
      badgeClass: "border-primary/25 bg-primary/10 text-primary",
    },
    completed: {
      label: "已完成",
      markerClass: "border-chart-4/30 bg-chart-4/15 text-foreground",
      badgeClass: "border-chart-4/30 bg-chart-4/15 text-foreground",
    },
    needs_review: {
      label: "需复习",
      markerClass: "border-chart-4/30 bg-chart-4/15 text-foreground",
      badgeClass: "border-chart-4/30 bg-chart-4/15 text-foreground",
    },
    generating: {
      label: "生成中",
      markerClass: "border-primary/20 bg-secondary text-primary",
      badgeClass: "border-primary/20 bg-secondary text-primary",
    },
    ready: {
      label: "已准备",
      markerClass: "border-primary/25 bg-primary/10 text-primary",
      badgeClass: "border-primary/25 bg-primary/10 text-primary",
    },
    in_progress: {
      label: "学习中",
      markerClass: "border-primary bg-primary text-primary-foreground",
      badgeClass: "border-primary bg-primary text-primary-foreground",
    },
    not_requested: {
      label: "未请求",
      markerClass: "border-border bg-background text-muted-foreground",
      badgeClass: "border-border bg-background text-muted-foreground",
    },
    superseded: {
      label: "历史版本",
      markerClass: "border-border bg-muted text-muted-foreground",
      badgeClass: "border-border bg-muted text-muted-foreground",
    },
  };
  return presentations[status] ?? {
    label: formatStatus(status),
    markerClass: "border-border bg-background text-muted-foreground",
    badgeClass: "border-border bg-background text-muted-foreground",
  };
}

function LoadingState() {
  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10">
      <div className="rounded-[1.5rem] border border-border/80 bg-card/75 p-6 shadow-[0_24px_70px_-46px_rgba(23,53,58,0.5)] sm:p-8">
        <div className="flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-secondary text-primary"><LoaderCircle aria-hidden className="size-4 animate-spin" /></span>
          <div>
            <p className="font-medium">正在准备学习路线</p>
            <p className="mt-1 text-sm text-muted-foreground">马上为你整理章节与下一步。</p>
          </div>
        </div>
        <div aria-hidden className="mt-8 grid gap-4">
          <span className="h-28 rounded-[1.25rem] bg-secondary/70" />
          <span className="h-36 rounded-[1.25rem] bg-secondary/70" />
          <span className="h-36 rounded-[1.25rem] bg-secondary/70" />
        </div>
      </div>
    </main>
  );
}

function formatStatus(value: string): string {
  const labels: Record<string, string> = {
    active: "进行中",
    available: "可学习",
    completed: "已完成",
    generating: "生成中",
    not_requested: "未请求",
    ready: "已准备",
    in_progress: "学习中",
    needs_review: "需复习",
    superseded: "历史版本",
  };
  return labels[value] ?? value;
}
