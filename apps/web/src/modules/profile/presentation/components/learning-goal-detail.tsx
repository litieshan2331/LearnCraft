/**
 * 学习目标详情组件。
 *
 * 组件：
 * - LearningGoalDetail：读取并展示单个学习目标，并在前测评分后提供路线生成入口。
 */

"use client";

import { AlertCircle, ArrowLeft, ArrowRight, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
  getLearningGoal,
  getLearningGoals,
  ProfileApiError,
  type LearningGoal,
  type LatestAssessmentSummary,
} from "../api/profile-client";
import { PlanGenerationAction } from "@/modules/planning/presentation/components/plan-generation-action";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";

export function LearningGoalDetail({ goalId }: Readonly<{ goalId: string }>) {
  const [goal, setGoal] = useState<LearningGoal | null>(null);
  const [latestAssessment, setLatestAssessment] = useState<LatestAssessmentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([getLearningGoal(goalId), getLearningGoals()])
      .then(([nextGoal, goals]) => {
        if (active) {
          setGoal(nextGoal);
          setLatestAssessment(goals.find((item) => item.id === goalId)?.latest_assessment ?? null);
        }
      })
      .catch((requestError: unknown) => {
        if (active) {
          setError(requestError instanceof ProfileApiError ? requestError.message : "暂时无法读取这个学习目标。" );
        }
      });
    return () => {
      active = false;
    };
  }, [goalId]);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10">
        <Alert className="rounded-xl border-destructive/25 bg-destructive/5 text-destructive" variant="destructive">
          <AlertCircle aria-hidden className="size-4" />
          <AlertTitle className="text-destructive">无法读取目标</AlertTitle>
          <AlertDescription className="mt-1 text-destructive">{error}</AlertDescription>
        </Alert>
        <Button asChild className="mt-6 rounded-xl" variant="outline">
          <Link href="/goals"><ArrowLeft aria-hidden className="size-4" />返回目标列表</Link>
        </Button>
      </main>
    );
  }

  if (!goal) {
    return <div className="grid min-h-80 place-items-center"><LoaderCircle aria-hidden className="size-5 animate-spin text-primary" /></div>;
  }

  const primaryAction = getPrimaryAction(goal, latestAssessment);
  const planGenerationAvailable = Boolean(goal.active_learning_plan_id) || latestAssessment?.status === "graded";

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12 sm:px-10 sm:py-16">
      <Button asChild className="rounded-xl" variant="ghost">
        <Link href="/goals"><ArrowLeft aria-hidden className="size-4" />返回目标列表</Link>
      </Button>
      <article className="mt-7 rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] p-6 sm:p-9">
        <p className="text-xs tracking-[0.18em] text-primary">{goal.topic}</p>
        <h1 className="mt-4 font-heading text-4xl font-medium tracking-tight">{goal.title}</h1>
        <p className="mt-5 text-sm leading-8 text-muted-foreground">{goal.description}</p>
        <div className="mt-7 rounded-2xl bg-secondary/55 p-5">
          <p className="text-xs tracking-[0.14em] text-primary">DESIRED OUTCOME</p>
          <p className="mt-3 leading-8">{goal.desired_outcome}</p>
        </div>
        <div className="mt-7 border-t border-border pt-6 text-sm">
          <p className="text-xs text-muted-foreground">目标日期</p>
          <p className="mt-1">{goal.target_date ?? "未设置"}</p>
        </div>
        {planGenerationAvailable ? (
          <>
            <PlanGenerationAction activePlanId={goal.active_learning_plan_id} goalId={goal.id} inFlightRunId={goal.latest_plan_run_id} />
            {latestAssessment ? (
              <Button asChild className="mt-3 rounded-xl" variant="outline">
                <Link href={"/assessments/" + latestAssessment.id}>查看前测<ArrowRight aria-hidden className="size-4" /></Link>
              </Button>
            ) : null}
          </>
        ) : primaryAction.href ? (
          <Button asChild className="mt-8 rounded-xl">
            <Link href={primaryAction.href}>{primaryAction.label}<ArrowRight aria-hidden className="size-4" /></Link>
          </Button>
        ) : (
          <Button className="mt-8 rounded-xl" disabled type="button">{primaryAction.label}</Button>
        )}
      </article>
    </main>
  );
}

function getPrimaryAction(
  goal: LearningGoal,
  latestAssessment: LatestAssessmentSummary | null,
): { label: string; href: string | null } {
  // 在途生成任务优先：这是从 AgentRun 派生的状态，不依赖 learning_goals.status（该列目前只写入创建时的默认值）。
  if (goal.latest_assessment_run_id) {
    return { label: "前测生成中", href: null };
  }
  if (goal.latest_plan_run_id) {
    return { label: "生成路线中", href: null };
  }
  if (latestAssessment && ["ready", "in_progress", "submitted", "grading", "graded"].includes(latestAssessment.status)) {
    return { label: "查看前测", href: `/assessments/${latestAssessment.id}` };
  }
  if (goal.status === "assessment_pending" || goal.status === "draft" || goal.status === "failed" || latestAssessment?.status === "failed") {
    return { label: "开始前测", href: `/goals/${goal.id}/assessment` };
  }
  return { label: "返回目标列表", href: "/goals" };
}
