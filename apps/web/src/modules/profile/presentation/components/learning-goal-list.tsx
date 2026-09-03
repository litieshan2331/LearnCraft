/**
 * 学习目标列表与删除交互组件。
 *
 * 函数与组件：
 * - LearningGoalList：加载并展示当前用户的全部学习目标。
 * - GoalCard：按状态、下一步和辅助信息展示单个目标。
 * - GoalStatusBadge：将既有目标状态呈现为可扫描的视觉标签。
 * - formatUpdatedAt：将更新时间格式化为中文日期。
 * - getAssessmentStatusLabel：转换前测状态文案。
 */

"use client";

import { AlertCircle, ArrowRight, CalendarDays, CircleDot, LoaderCircle, Plus, RefreshCw, Target, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  deleteLearningGoal,
  getLearningGoals,
  ProfileApiError,
  type LearningGoalListItem,
  type LatestAssessmentStatus,
} from "../api/profile-client";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";

export function LearningGoalList() {
  const [goals, setGoals] = useState<LearningGoalListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingGoalId, setDeletingGoalId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadGoals = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setLoadError(null);

    try {
      setGoals(await getLearningGoals());
    } catch (error) {
      setLoadError(toDisplayError(error, "暂时无法读取学习目标，请稍后重试。"));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;

    void getLearningGoals()
      .then((nextGoals) => {
        if (active) {
          setGoals(nextGoals);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(toDisplayError(error, "暂时无法读取学习目标，请稍后重试。"));
        }
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  async function handleDelete(goal: LearningGoalListItem): Promise<void> {
    if (!window.confirm(`确定删除“${goal.title}”吗？删除后相关题集和任务记录也会被移除。`)) {
      return;
    }

    setDeletingGoalId(goal.id);
    setDeleteError(null);
    try {
      await deleteLearningGoal(goal.id);
      setGoals((current) => current.filter((item) => item.id !== goal.id));
    } catch (error) {
      setDeleteError(toDisplayError(error, "目标删除失败，请稍后重试。"));
    } finally {
      setDeletingGoalId(null);
    }
  }

  return (
    <main className="relative mx-auto w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="lc-float absolute -top-10 right-8 size-64 rounded-full bg-primary/[0.08] blur-3xl" />
        <div className="lc-float-slow absolute bottom-8 left-8 size-44 rounded-full bg-chart-4/[0.1] blur-3xl" />
      </div>
      <div className="relative">
        <header className="flex flex-col gap-6 rounded-[1.5rem] border border-border/80 bg-card/80 p-5 shadow-[0_24px_70px_-46px_rgba(23,53,58,0.5)] backdrop-blur sm:p-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-[0.14em] text-primary">
              <Target aria-hidden className="size-3.5" />
              MY LEARNING GOALS
            </p>
            <h1 className="mt-5 font-heading text-4xl font-medium tracking-tight sm:text-5xl">我的学习目标</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
              每个目标都有独立的前测和后续学习路线。找到想继续的目标，然后从下一步开始。
            </p>
          </div>
          <Button asChild className="h-11 shrink-0 rounded-xl px-5 shadow-[0_14px_32px_-22px_rgba(36,122,128,0.85)]">
            <Link href="/onboarding">
              <Plus aria-hidden className="size-4" />
              创建另一个目标
            </Link>
          </Button>
        </header>

        {loadError ? (
          <Alert className="mt-6 rounded-2xl border-destructive/25 bg-destructive/5 text-destructive" variant="destructive">
            <AlertCircle aria-hidden className="size-4" />
            <AlertTitle className="text-destructive">无法加载目标</AlertTitle>
            <AlertDescription className="mt-1 text-destructive">{loadError}</AlertDescription>
          </Alert>
        ) : null}

        {deleteError ? (
          <Alert className="mt-4 rounded-2xl border-destructive/25 bg-destructive/5 text-destructive" variant="destructive">
            <AlertCircle aria-hidden className="size-4" />
            <AlertTitle className="text-destructive">无法删除目标</AlertTitle>
            <AlertDescription className="mt-1 text-destructive">{deleteError}</AlertDescription>
          </Alert>
        ) : null}

        <section className="mt-6">
          <div className="flex items-center justify-between gap-4 px-1">
            <div>
              <p className="text-xs font-medium tracking-[0.16em] text-primary">YOUR NEXT STEPS</p>
              <p className="mt-2 text-sm text-muted-foreground">{isLoading ? "正在读取目标…" : `${goals.length} 个学习目标`}</p>
            </div>
            <Button aria-label="刷新学习目标" className="size-10 rounded-xl border border-border bg-card/80 hover:bg-secondary" disabled={isLoading} onClick={() => void loadGoals()} size="icon" type="button" variant="ghost">
              <RefreshCw aria-hidden className={isLoading ? "size-4 animate-spin" : "size-4"} />
            </Button>
          </div>

          {isLoading ? <LoadingState /> : null}
          {!isLoading && !loadError && goals.length === 0 ? <EmptyState /> : null}
          {!isLoading && !loadError && goals.length > 0 ? (
            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              {goals.map((goal) => (
                <GoalCard
                  deleting={deletingGoalId === goal.id}
                  goal={goal}
                  key={goal.id}
                  onDelete={() => void handleDelete(goal)}
                />
              ))}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function GoalCard({
  goal,
  deleting,
  onDelete,
}: Readonly<{ goal: LearningGoalListItem; deleting: boolean; onDelete: () => void }>) {
  const assessment = goal.latest_assessment;
  const primaryAction = getPrimaryAction(goal);

  return (
    <article className="group rounded-[1.25rem] border border-border/80 bg-card/85 p-5 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] transition-all hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-[0_24px_55px_-38px_rgba(36,122,128,0.38)] sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium tracking-[0.14em] text-primary">{goal.topic}</p>
          <h2 className="mt-3 font-heading text-2xl font-medium tracking-tight">{goal.title}</h2>
        </div>
        <GoalStatusBadge status={goal.status} />
      </div>

      <p className="mt-4 line-clamp-2 text-sm leading-7 text-muted-foreground">{goal.description}</p>

      <div className="mt-5 grid gap-3 rounded-2xl bg-secondary/55 p-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><CircleDot aria-hidden className="size-3.5 text-primary" />当前前测</p>
          <p className="mt-2 font-medium">{assessment ? getAssessmentStatusLabel(assessment.status) : "尚未生成"}</p>
          {assessment?.score_percent !== null && assessment?.score_percent !== undefined ? (
            <p className="mt-1 text-xs text-muted-foreground">得分 {assessment.score_percent}%</p>
          ) : null}
        </div>
        <p className="inline-flex items-center gap-2 text-xs text-muted-foreground sm:justify-self-end">
          <CalendarDays aria-hidden className="size-3.5" />
          更新于 {formatUpdatedAt(goal.updated_at)}
        </p>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {primaryAction.href ? (
          <Button asChild className="h-11 rounded-xl px-5">
            <Link href={primaryAction.href}>
              {primaryAction.label}
              <ArrowRight aria-hidden className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
        ) : (
          <Button className="h-11 rounded-xl px-5" disabled type="button">
            {primaryAction.label}
          </Button>
        )}
        <Button asChild className="h-11 rounded-xl px-4" variant="outline">
          <Link href={`/goals/${goal.id}`}>查看详情</Link>
        </Button>
        <Button aria-label={`删除${goal.title}`} className="ml-auto h-10 rounded-xl px-3 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" disabled={deleting} onClick={onDelete} type="button" variant="ghost">
          {deleting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <Trash2 aria-hidden className="size-4" />}
          删除
        </Button>
      </div>
    </article>
  );
}

function GoalStatusBadge({ status }: Readonly<{ status: LearningGoalListItem["status"] }>) {
  const presentation = getGoalStatusPresentation(status);
  return <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${presentation.className}`}>{presentation.label}</span>;
}

function getGoalStatusPresentation(status: LearningGoalListItem["status"]): { label: string; className: string } {
  const presentations: Record<LearningGoalListItem["status"], { label: string; className: string }> = {
    draft: { label: "草稿", className: "border-border bg-background text-muted-foreground" },
    assessment_pending: { label: "等待前测", className: "border-primary/20 bg-primary/10 text-primary" },
    assessment_in_progress: { label: "前测中", className: "border-primary/20 bg-primary/10 text-primary" },
    planning: { label: "生成路线中", className: "border-chart-4/30 bg-chart-4/15 text-foreground" },
    active: { label: "学习中", className: "border-primary/25 bg-primary text-primary-foreground" },
    completed: { label: "已完成", className: "border-chart-4/30 bg-chart-4/15 text-foreground" },
    archived: { label: "已归档", className: "border-border bg-muted text-muted-foreground" },
    failed: { label: "需要处理", className: "border-destructive/25 bg-destructive/10 text-destructive" },
  };
  return presentations[status];
}

function getPrimaryAction(goal: LearningGoalListItem): { label: string; href: string | null } {
  if (goal.active_learning_plan_id) {
    return { label: "查看学习路线", href: "/learning-plans/" + goal.active_learning_plan_id };
  }
  const assessment = goal.latest_assessment;
  if (assessment && ["ready", "in_progress", "submitted", "grading", "graded"].includes(assessment.status)) {
    return { label: "查看前测", href: `/assessments/${assessment.id}` };
  }
  if (goal.status === "assessment_in_progress" || goal.status === "planning" || assessment?.status === "generating") {
    return { label: "前测生成中", href: null };
  }
  if (goal.status === "assessment_pending" || goal.status === "draft" || goal.status === "failed" || assessment?.status === "failed") {
    return { label: "开始前测", href: `/goals/${goal.id}/assessment` };
  }
  return { label: "查看详情", href: `/goals/${goal.id}` };
}

function LoadingState() {
  return (
    <div className="mt-5 rounded-[1.25rem] border border-border/80 bg-card/70 p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-2xl bg-secondary text-primary"><LoaderCircle aria-hidden className="size-4 animate-spin" /></span>
        <div>
          <p className="font-medium">正在读取学习目标</p>
          <p className="mt-1 text-sm text-muted-foreground">请稍候，我们正在整理你的下一步。</p>
        </div>
      </div>
      <div aria-hidden className="mt-7 grid gap-3 lg:grid-cols-2">
        <span className="h-44 rounded-[1.25rem] bg-secondary/70" />
        <span className="h-44 rounded-[1.25rem] bg-secondary/70" />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-5 rounded-[1.25rem] border border-dashed border-primary/25 bg-card/70 px-6 py-14 text-center sm:py-18">
      <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary"><Target aria-hidden className="size-5" /></span>
      <p className="mt-5 font-heading text-2xl font-medium">还没有学习目标</p>
      <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-muted-foreground">先创建一个具体的编程学习主题，LearnCraft 会根据你的画像生成前测和学习路线。</p>
      <Button asChild className="mt-7 h-11 rounded-xl px-5">
        <Link href="/onboarding">创建第一个目标</Link>
      </Button>
    </div>
  );
}

function getAssessmentStatusLabel(status: LatestAssessmentStatus): string {
  const labels: Record<LatestAssessmentStatus, string> = {
    generating: "题集生成中",
    ready: "可以开始",
    in_progress: "答题中",
    submitted: "等待评分",
    grading: "评分中",
    graded: "已完成",
    failed: "生成失败",
    archived: "已归档",
  };
  return labels[status];
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric" }).format(new Date(value));
}

function toDisplayError(error: unknown, fallback: string): string {
  if (error instanceof ProfileApiError && error.code === "GOAL_HAS_ACTIVE_RUNS") {
    return "该目标仍有进行中的 Agent 任务，请先取消或等待任务结束后再删除。";
  }
  return error instanceof Error ? error.message : fallback;
}
