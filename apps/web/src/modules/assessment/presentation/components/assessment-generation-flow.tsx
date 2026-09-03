/**
 * 学习目标前测生成流程组件。
 *
 * 组件：
 * - AssessmentGenerationFlow：读取学习目标，提交前测生成任务，并轮询 AgentRun 状态后跳转至题集。
 * - LoadingState：展示目标数据加载中的稳定占位状态。
 */

"use client";

import {
  AlertCircle,
  ArrowLeft,
  CircleStop,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  AssessmentApiError,
  cancelAgentRun,
  createAssessmentRun,
  getAgentRun,
  type AgentRun,
  type AssessmentDifficulty,
} from "../api/assessment-client";
import {
  getLearningGoal,
  type LearningGoal,
} from "@/modules/profile/presentation/api/profile-client";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";
import { Field, FieldDescription, FieldLabel } from "@/shared/ui/primitives/field";
import { Input } from "@/shared/ui/primitives/input";

const POLL_INTERVAL_MS = 2_000;

export function AssessmentGenerationFlow({ goalId }: Readonly<{ goalId: string }>) {
  const router = useRouter();
  const [goal, setGoal] = useState<LearningGoal | null>(null);
  const [isLoadingGoal, setIsLoadingGoal] = useState(true);
  const [questionCount, setQuestionCount] = useState(10);
  const [difficulty, setDifficulty] = useState<AssessmentDifficulty>("normal");
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const activeRunId = agentRun?.id ?? null;
  const activeRunStatus = agentRun?.status ?? null;

  useEffect(() => {
    let isActive = true;

    void getLearningGoal(goalId)
      .then((nextGoal) => {
        if (isActive) {
          setGoal(nextGoal);
        }
      })
      .catch((error: unknown) => {
        if (isActive) {
          setErrorMessage(toDisplayError(error, '暂时无法读取这个学习目标。'));
        }
      })
      .finally(() => {
        if (isActive) {
          setIsLoadingGoal(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [goalId]);

  useEffect(() => {
    if (!activeRunId || !activeRunStatus || !isInFlight(activeRunStatus)) {
      return;
    }

    let isActive = true;
    let timeoutId: number | undefined;

    const poll = async (): Promise<void> => {
      try {
        const latestRun = await getAgentRun(activeRunId);
        if (!isActive) {
          return;
        }

        setAgentRun(latestRun);

        if (latestRun.status === "succeeded") {
          const assessmentId = latestRun.assessment_result?.assessment_id;
          if (assessmentId) {
            router.replace(`/assessments/${assessmentId}`);
            return;
          }
          setErrorMessage("任务已完成，但未返回可读取的题集编号。请重新发起前测。");
          return;
        }

        if (latestRun.status === "failed") {
          setErrorMessage(latestRun.error?.message ?? "前测生成失败，请重新发起。" );
          return;
        }

        if (latestRun.status === "cancelled" || latestRun.status === "expired") {
          return;
        }
      } catch (error) {
        if (isActive) {
          setErrorMessage(toDisplayError(error, "前测任务状态暂时无法读取。"));
        }
        return;
      }

      if (isActive) {
        timeoutId = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };

    void poll();

    return () => {
      isActive = false;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activeRunId, activeRunStatus, router]);

  async function handleGenerate(): Promise<void> {
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const nextRun = await createAssessmentRun(
        goalId,
        {
          kind: "diagnostic",
          question_count: questionCount,
          difficulty,
        },
        crypto.randomUUID(),
      );
      setAgentRun(nextRun);
    } catch (error) {
      setErrorMessage(toDisplayError(error, "前测任务暂时无法创建。"));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCancel(): Promise<void> {
    if (!agentRun) {
      return;
    }

    setErrorMessage(null);
    setIsCancelling(true);
    try {
      setAgentRun(await cancelAgentRun(agentRun.id));
    } catch (error) {
      setErrorMessage(toDisplayError(error, "暂时无法取消任务，请稍后重试。"));
    } finally {
      setIsCancelling(false);
    }
  }

  if (isLoadingGoal) {
    return <LoadingState />;
  }

  if (!goal) {
    return (
      <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10">
        <Alert className="rounded-xl border-destructive/25 bg-destructive/5 text-destructive" variant="destructive">
          <AlertCircle aria-hidden className="size-4" />
          <AlertTitle className="text-destructive">无法打开前测</AlertTitle>
          <AlertDescription className="mt-1 text-destructive">{errorMessage ?? "学习目标不存在或你无权访问。"}</AlertDescription>
        </Alert>
        <Button asChild className="mt-6 rounded-xl" variant="outline">
          <Link href="/onboarding"><ArrowLeft aria-hidden />返回学习起点</Link>
        </Button>
      </main>
    );
  }

  const taskIsInFlight = agentRun ? isInFlight(agentRun.status) : false;
  const taskIsTerminal = agentRun ? isTerminal(agentRun.status) : false;

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground" href="/onboarding">
        <ArrowLeft aria-hidden className="size-4" />
        返回学习起点
      </Link>

      <section className="mt-7 rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] p-5 sm:p-8">
        <div className="flex flex-col gap-5 border-b border-border/80 pb-7 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 text-primary">
              <Sparkles aria-hidden className="size-4" />
              <p className="text-xs tracking-[0.16em]">DIAGNOSTIC / 前测</p>
            </div>
            <h1 className="mt-3 font-heading text-3xl font-medium tracking-tight">先从你的真实起点开始</h1>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              LearnCraft 会根据目标与学习背景生成选择题，用于确定后续路线的切入点。
            </p>
          </div>
          <div className="shrink-0 rounded-2xl border border-border/80 bg-background/65 px-4 py-3 text-right">
            <p className="text-[11px] tracking-[0.14em] text-muted-foreground">CURRENT GOAL</p>
            <p className="mt-1 max-w-52 truncate text-sm font-medium" title={goal.title}>{goal.title}</p>
          </div>
        </div>

        {errorMessage ? (
          <Alert className="mt-6 rounded-xl border-destructive/25 bg-destructive/5 text-destructive" variant="destructive">
            <AlertCircle aria-hidden className="size-4" />
            <AlertTitle className="text-destructive">前测未能完成</AlertTitle>
            <AlertDescription className="mt-1 text-destructive">{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {taskIsInFlight && agentRun ? (
          <TaskProgress agentRun={agentRun} isCancelling={isCancelling} onCancel={() => void handleCancel()} />
        ) : (
          <div className="mt-7">
            <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <Field>
                <FieldLabel htmlFor="diagnostic-question-count">题目数量</FieldLabel>
                <Input
                  id="diagnostic-question-count"
                  max={20}
                  min={10}
                  onChange={(event) => setQuestionCount(clampQuestionCount(event.target.value))}
                  type="number"
                  value={questionCount}
                />
                <FieldDescription>推荐 10–20 题，题数越多越能覆盖你的知识边界。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>难度</FieldLabel>
                <div className="grid grid-cols-2 gap-3">
                  <DifficultyCard
                    checked={difficulty === "normal"}
                    description="从核心概念和常见实践开始。"
                    label="正常"
                    onSelect={() => setDifficulty("normal")}
                  />
                  <DifficultyCard
                    checked={difficulty === "hard"}
                    description="增加边界条件、原理和调试场景。"
                    label="困难"
                    onSelect={() => setDifficulty("hard")}
                  />
                </div>
              </Field>
            </div>

            {taskIsTerminal && agentRun?.status === "cancelled" ? (
              <p className="mt-6 text-sm text-muted-foreground">上一次生成已取消。可以调整配置后重新开始。</p>
            ) : null}

            <div className="mt-8 flex flex-col-reverse gap-3 rounded-2xl bg-secondary/55 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                将使用你的账户默认模型。生成过程可取消，取消后不会产生题集。
              </p>
              <Button className="h-11 shrink-0 rounded-xl px-5" disabled={isSubmitting} onClick={() => void handleGenerate()} type="button">
                {isSubmitting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <Sparkles aria-hidden className="size-4" />}
                {agentRun?.status === "failed" ? "重新生成前测" : "生成前测"}
              </Button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function TaskProgress({
  agentRun,
  isCancelling,
  onCancel,
}: Readonly<{
  agentRun: AgentRun;
  isCancelling: boolean;
  onCancel: () => void;
}>) {
  return (
    <div className="mt-7 rounded-2xl border border-border/80 bg-background/65 p-5">
      <div className="flex items-start justify-between gap-5">
        <div className="flex gap-3">
          <LoaderCircle aria-hidden className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
          <div>
            <p className="font-medium">{agentRun.status === "queued" ? "正在等待生成" : "正在生成前测"}</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {agentRun.status === "queued" ? "任务已进入队列，准备交给 Agent Worker。" : "模型正在分析你的学习目标并组织题目。"}
            </p>
          </div>
        </div>
        <span className="rounded-full border border-border/80 bg-card px-2.5 py-1 text-xs tracking-[0.12em] text-muted-foreground">
          {agentRun.status.toUpperCase()}
        </span>
      </div>
      <div className="mt-5 h-px overflow-hidden bg-border">
        <div className="h-full w-2/5 animate-pulse bg-primary" />
      </div>
      <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-muted-foreground">页面会自动刷新任务状态，生成完成后将打开题集。</p>
        <Button className="rounded-xl" disabled={isCancelling} onClick={onCancel} type="button" variant="outline">
          {isCancelling ? <RefreshCw aria-hidden className="size-4 animate-spin" /> : <CircleStop aria-hidden className="size-4" />}
          {isCancelling ? "正在取消" : "取消生成"}
        </Button>
      </div>
    </div>
  );
}

function DifficultyCard({
  checked,
  description,
  label,
  onSelect,
}: Readonly<{
  checked: boolean;
  description: string;
  label: string;
  onSelect: () => void;
}>) {
  return (
    <button
      aria-pressed={checked}
      className={`rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 ${checked ? "border-primary bg-primary/[0.07] shadow-[0_14px_32px_-24px_rgba(36,122,128,0.65)]" : "border-border bg-card hover:border-primary/60"}`}
      onClick={onSelect}
      type="button"
    >
      <span className="block font-medium">{label}</span>
      <span className="mt-2 block text-xs leading-5 text-muted-foreground">{description}</span>
    </button>
  );
}

function LoadingState() {
  return (
    <main className="grid min-h-80 place-items-center rounded-[1.25rem] bg-card/70 px-6 text-center">
      <div>
        <LoaderCircle aria-hidden className="mx-auto size-5 animate-spin text-primary" />
        <p className="mt-4 text-sm text-muted-foreground">正在准备你的前测配置…</p>
      </div>
    </main>
  );
}

function isInFlight(status: AgentRun["status"]): boolean {
  return status === "queued" || status === "running";
}

function isTerminal(status: AgentRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "expired";
}

function clampQuestionCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return 10;
  }
  return Math.min(20, Math.max(10, parsed));
}

function toDisplayError(error: unknown, fallback: string): string {
  if (error instanceof AssessmentApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}
