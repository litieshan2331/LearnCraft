/**
 * 学习路线生成操作组件。
 *
 * 组件与函数：
 * - PlanGenerationAction：创建 plan_generate 任务、轮询状态，并在成功后跳转至学习路线。
 * - isInFlight：判断 AgentRun 是否仍在执行。
 * - toDisplayError：将安全接口错误转换为用户可读文案。
 */

"use client";

import { AlertCircle, ArrowRight, LoaderCircle, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";

import {
  createPlanGenerationRun,
  getPlanGenerationRun,
  PlanningApiError,
  type PlanGenerationAgentRun,
} from "../api/planning-client";

const POLL_INTERVAL_MS = 2_000;

export function PlanGenerationAction({
  goalId,
  activePlanId = null,
}: Readonly<{ goalId: string; activePlanId?: string | null }>) {
  const router = useRouter();
  const [agentRun, setAgentRun] = useState<PlanGenerationAgentRun | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const activeRunId = agentRun?.id ?? null;
  const activeRunStatus = agentRun?.status ?? null;
  const taskIsInFlight = activeRunStatus ? isInFlight(activeRunStatus) : false;

  useEffect(() => {
    if (!activeRunId || !activeRunStatus || !isInFlight(activeRunStatus)) {
      return;
    }

    let active = true;
    let timeoutId: number | undefined;

    const poll = async (): Promise<void> => {
      try {
        const latestRun = await getPlanGenerationRun(activeRunId);
        if (!active) {
          return;
        }

        setAgentRun(latestRun);

        if (latestRun.status === "succeeded") {
          const planId = latestRun.plan_result?.learning_plan_id;
          if (planId) {
            router.replace("/learning-plans/" + planId);
            return;
          }
          setErrorMessage("学习路线已生成，但未返回路线编号。请重新发起生成。");
          return;
        }

        if (latestRun.status === "failed") {
          setErrorMessage(latestRun.error?.message ?? "学习路线生成失败，请重新发起。");
          return;
        }

        if (latestRun.status === "cancelled" || latestRun.status === "expired") {
          setErrorMessage("学习路线生成任务已结束，请重新发起。");
          return;
        }
      } catch (error) {
        if (active) {
          setErrorMessage(toDisplayError(error, "学习路线任务状态暂时无法读取。"));
        }
        return;
      }

      if (active) {
        timeoutId = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };

    void poll();

    return () => {
      active = false;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activeRunId, activeRunStatus, router]);

  async function handleGenerate(): Promise<void> {
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const nextRun = await createPlanGenerationRun(goalId, crypto.randomUUID());
      setAgentRun(nextRun);
      if (nextRun.status === "succeeded") {
        const planId = nextRun.plan_result?.learning_plan_id;
        if (planId) {
          router.replace("/learning-plans/" + planId);
        } else {
          setErrorMessage("学习路线已生成，但未返回路线编号。请重新发起生成。");
        }
      } else if (nextRun.status === "failed") {
        setErrorMessage(nextRun.error?.message ?? "学习路线生成失败，请重新发起。");
      }
    } catch (error) {
      setErrorMessage(toDisplayError(error, "学习路线任务暂时无法创建。"));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (activePlanId) {
    return (
      <div className="mt-8 flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-sm leading-6 text-muted-foreground">
          当前学习路线已经生成，可随时返回章节目录继续学习。
        </p>
        <Button asChild className="h-11 shrink-0 rounded-none px-5">
          <Link href={"/learning-plans/" + activePlanId}>查看学习路线<ArrowRight aria-hidden className="size-4" /></Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-8">
      {errorMessage ? (
        <Alert className="mb-5 rounded-none border-[#d9b4a9] bg-[#fff8f5] text-[#8b3f35]" variant="destructive">
          <AlertCircle aria-hidden className="size-4" />
          <AlertTitle className="text-[#8b3f35]">学习路线未能完成</AlertTitle>
          <AlertDescription className="mt-1 text-[#8b3f35]">{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {taskIsInFlight && agentRun ? (
        <div className="border border-border bg-background p-5">
          <div className="flex items-start gap-3">
            <LoaderCircle aria-hidden className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
            <div>
              <p className="font-medium">{agentRun.status === "queued" ? "正在等待路线生成" : "正在生成学习路线"}</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Agent 正在结合你的目标、画像和前测结果组织章节目录，完成后会自动打开路线。
              </p>
            </div>
          </div>
          <div className="mt-5 h-px overflow-hidden bg-border">
            <div className="h-full w-2/5 animate-pulse bg-primary" />
          </div>
        </div>
      ) : (
        <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            将使用已评分前测、当前学习画像和账户默认模型生成 6–12 个章节。
          </p>
          <Button className="h-11 shrink-0 rounded-none px-5" disabled={isSubmitting} onClick={() => void handleGenerate()} type="button">
            {isSubmitting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <Sparkles aria-hidden className="size-4" />}
            {agentRun ? "重新生成学习路线" : "生成学习路线"}
            {!isSubmitting ? <ArrowRight aria-hidden className="size-4" /> : null}
          </Button>
        </div>
      )}
    </div>
  );
}

function isInFlight(status: PlanGenerationAgentRun["status"]): boolean {
  return status === "queued" || status === "running";
}

function toDisplayError(error: unknown, fallback: string): string {
  if (error instanceof PlanningApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}
