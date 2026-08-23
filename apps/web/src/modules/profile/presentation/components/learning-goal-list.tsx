/**
 * 学习目标列表与删除交互组件。
 *
 * 函数与组件：
 * - LearningGoalList：加载并展示当前用户的全部学习目标。
 * - GoalCard：展示单个目标、前测状态和可执行操作。
 * - formatUpdatedAt：将更新时间格式化为中文日期。
 * - getAssessmentStatusLabel：转换前测状态文案。
 */

"use client";

import { AlertCircle, ArrowRight, CalendarDays, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
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
    <main className="mx-auto w-full max-w-6xl px-6 py-12 sm:px-10 sm:py-16">
      <div className="flex flex-col gap-6 border-b border-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs tracking-[0.2em] text-primary">MY LEARNING GOALS</p>
          <h1 className="mt-4 font-heading text-4xl font-normal tracking-tight sm:text-5xl">我的学习目标</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
            每个目标都有独立的前测和后续学习路线。你可以随时回到任意目标继续学习。
          </p>
        </div>
        <Button asChild className="h-10 shrink-0 rounded-none px-4">
          <Link href="/onboarding">
            <Plus aria-hidden className="size-4" />
            创建另一个目标
          </Link>
        </Button>
      </div>

      {loadError ? (
        <Alert className="mt-7 rounded-none border-[#d9b4a9] bg-[#fff8f5] text-[#8b3f35]" variant="destructive">
          <AlertCircle aria-hidden className="size-4" />
          <AlertTitle className="text-[#8b3f35]">无法加载目标</AlertTitle>
          <AlertDescription className="mt-1 text-[#8b3f35]">{loadError}</AlertDescription>
        </Alert>
      ) : null}

      {deleteError ? (
        <Alert className="mt-4 rounded-none border-[#d9b4a9] bg-[#fff8f5] text-[#8b3f35]" variant="destructive">
          <AlertCircle aria-hidden className="size-4" />
          <AlertTitle className="text-[#8b3f35]">无法删除目标</AlertTitle>
          <AlertDescription className="mt-1 text-[#8b3f35]">{deleteError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-8 flex items-center justify-between border-b border-border pb-4">
        <div>
          <p className="text-xs tracking-[0.16em] text-primary">SAVED GOALS</p>
          <p className="mt-2 text-sm text-muted-foreground">{isLoading ? "正在读取…" : `${goals.length} 个学习目标`}</p>
        </div>
        <Button aria-label="刷新学习目标" className="rounded-none" disabled={isLoading} onClick={() => void loadGoals()} size="icon-sm" type="button" variant="ghost">
          <RefreshCw aria-hidden className={isLoading ? "animate-spin" : ""} />
        </Button>
      </div>

      {isLoading ? <LoadingState /> : null}
      {!isLoading && !loadError && goals.length === 0 ? <EmptyState /> : null}
      {!isLoading && !loadError && goals.length > 0 ? (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
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
    <article className="border border-border border-l-2 border-l-primary bg-card p-5 sm:p-6">
      <div className="min-w-0">
        <p className="truncate text-xs tracking-[0.16em] text-primary">{goal.topic}</p>
        <h2 className="mt-3 font-heading text-2xl font-normal tracking-tight">{goal.title}</h2>
      </div>

      <p className="mt-4 line-clamp-2 text-sm leading-7 text-muted-foreground">{goal.description}</p>

      <div className="mt-5 grid gap-3 border-y border-border py-4 text-sm sm:grid-cols-2">
        <div>
          <p className="text-xs tracking-[0.12em] text-muted-foreground">最新前测</p>
          <p className="mt-1">{assessment ? getAssessmentStatusLabel(assessment.status) : "尚未生成"}</p>
          {assessment?.score_percent !== null && assessment?.score_percent !== undefined ? (
            <p className="mt-1 text-xs text-muted-foreground">得分 {assessment.score_percent}%</p>
          ) : null}
        </div>
        <div className="flex items-start gap-2 text-muted-foreground">
          <CalendarDays aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>更新于 {formatUpdatedAt(goal.updated_at)}</span>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {primaryAction.href ? (
          <Button asChild className="rounded-none">
            <Link href={primaryAction.href}>
              {primaryAction.label}
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </Button>
        ) : (
          <Button className="rounded-none" disabled type="button">
            {primaryAction.label}
          </Button>
        )}
        <Button asChild className="rounded-none" variant="outline">
          <Link href={`/goals/${goal.id}`}>查看详情</Link>
        </Button>
        <Button aria-label={`删除${goal.title}`} className="ml-auto rounded-none" disabled={deleting} onClick={onDelete} type="button" variant="ghost">
          {deleting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <Trash2 aria-hidden className="size-4" />}
          删除
        </Button>
      </div>
    </article>
  );
}

function getPrimaryAction(goal: LearningGoalListItem): { label: string; href: string | null } {
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
    <div className="mt-5 grid place-items-center border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <LoaderCircle aria-hidden className="size-5 animate-spin text-primary" />
      <p className="mt-3 text-sm text-muted-foreground">正在读取你的学习目标…</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-5 border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <p className="font-heading text-2xl font-normal">还没有学习目标</p>
      <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-muted-foreground">先创建一个具体的编程学习主题，LearnCraft 会根据你的画像生成前测和学习路线。</p>
      <Button asChild className="mt-6 rounded-none">
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
