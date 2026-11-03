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

import { AgentRunProgress } from "@/modules/agent-run/presentation/components/agent-run-progress";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";

import {
  createPlanGenerationRun,
  getPlanGenerationRun,
  submitPlanHumanReview,
  PlanningApiError,
  type PlanGenerationAgentRun,
} from "../api/planning-client";

const POLL_INTERVAL_MS = 2_000;

export function PlanGenerationAction({
  goalId,
  activePlanId,
  inFlightRunId,
}: Readonly<{
  goalId: string;
  activePlanId: string | null;
  /**
   * 目标上在途的 plan_generate 任务 id：刷新后据此接回同一个任务的进度流。
   * 刻意设为必填——漏传会让「刷新后仍在生成中」静默失效，因此由类型检查兜住。
   */
  inFlightRunId: string | null;
}>) {
  const router = useRouter();
  const [agentRun, setAgentRun] = useState<PlanGenerationAgentRun | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reviewAnswers, setReviewAnswers] = useState<Record<string, { option_id: string; custom_text?: string }>>({});
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

  const activeRunId = agentRun?.id ?? null;
  const activeRunStatus = agentRun?.status ?? null;
  const taskIsInFlight = activeRunStatus ? isInFlight(activeRunStatus) : false;
  const taskIsWaiting = activeRunStatus === "waiting_for_human" && Boolean(agentRun?.human_review);

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

  // 刷新后本地没有 run 对象：用目标上带来的在途 run id 取回同一个任务，进度展示与轮询接着走。
  useEffect(() => {
    if (agentRun || !inFlightRunId) {
      return;
    }

    let active = true;
    void getPlanGenerationRun(inFlightRunId)
      .then((latestRun) => {
        if (!active) {
          return;
        }
        setAgentRun(latestRun);
        if (latestRun.status === "succeeded") {
          const planId = latestRun.plan_result?.learning_plan_id;
          if (planId) {
            router.replace("/learning-plans/" + planId);
          } else {
            setErrorMessage("学习路线已生成，但未返回路线编号。请重新发起生成。");
          }
          return;
        }
        if (latestRun.status === "failed") {
          setErrorMessage(latestRun.error?.message ?? "学习路线生成失败，请重新发起。");
          return;
        }
        if (latestRun.status === "cancelled" || latestRun.status === "expired") {
          setErrorMessage("学习路线生成任务已结束，请重新发起。");
        }
      })
      .catch(() => {
        // 读不到就退回静态状态，不打断页面。
      });

    return () => {
      active = false;
    };
  }, [agentRun, inFlightRunId, router]);

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

  async function handleSubmitReview(): Promise<void> {
    if (!agentRun?.human_review || isSubmittingReview) return;
    const review = agentRun.human_review;
    const answers = review.questions.map((question) => {
      const answer = reviewAnswers[question.question_id];
      const option = question.options.find((item) => item.option_id === answer?.option_id);
      if (!answer || !option) return null;
      if (option.kind === "custom_text") {
        const customText = answer.custom_text ?? "";
        if (!option.input || customText.length < option.input.min_length || customText.length > option.input.max_length) return null;
        return { question_id: question.question_id, option_id: option.option_id, custom_text: customText };
      }
      return { question_id: question.question_id, option_id: option.option_id };
    });
    if (answers.some((answer) => answer === null)) {
      setErrorMessage("请回答全部问题，并补充自定义选项内容。");
      return;
    }
    setErrorMessage(null);
    setIsSubmittingReview(true);
    try {
      const submitted = await submitPlanHumanReview(
        agentRun.id,
        { review_id: review.review_id, answers: answers as Array<{ question_id: string; option_id: string; custom_text?: string }> },
        crypto.randomUUID(),
      );
      setAgentRun({ ...agentRun, ...submitted, status: "queued", human_review: undefined });
    } catch (error) {
      setErrorMessage(toDisplayError(error, "人工确认暂时无法提交，请稍后重试。"));
    } finally {
      setIsSubmittingReview(false);
    }
  }

  if (activePlanId) {
    return (
      <div className="mt-8 flex flex-col-reverse gap-3 rounded-2xl bg-secondary/55 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-sm leading-6 text-muted-foreground">
          当前学习路线已经生成，可随时返回章节目录继续学习。
        </p>
        <Button asChild className="h-11 shrink-0 rounded-xl px-5">
          <Link href={"/learning-plans/" + activePlanId}>查看学习路线<ArrowRight aria-hidden className="size-4" /></Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-8">
      {errorMessage ? (
        <Alert className="mb-5 rounded-xl border-destructive/25 bg-destructive/5 text-destructive" variant="destructive">
          <AlertCircle aria-hidden className="size-4" />
          <AlertTitle className="text-destructive">学习路线未能完成</AlertTitle>
          <AlertDescription className="mt-1 text-destructive">{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {taskIsWaiting && agentRun?.human_review ? (
        <div className="rounded-2xl border border-primary/25 bg-primary/5 p-5">
          <div className="flex items-start gap-3">
            <Sparkles aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
            <div>
              <p className="font-medium">先确认几个学习偏好</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Agent 会结合你的回答生成更贴合的学习路线。</p>
            </div>
          </div>
          <div className="mt-5 space-y-5">
            {agentRun.human_review.questions.map((question) => {
              const selected = reviewAnswers[question.question_id];
              const selectedOption = question.options.find((option) => option.option_id === selected?.option_id);
              return (
                <fieldset className="space-y-2" key={question.question_id}>
                  <legend className="text-sm font-medium">{question.prompt}</legend>
                  {question.options.map((option) => (
                    <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border/80 bg-background/70 px-3 py-2 text-sm" key={option.option_id}>
                      <input
                        checked={selected?.option_id === option.option_id}
                        className="mt-1"
                        disabled={isSubmittingReview}
                        name={question.question_id}
                        onChange={() => setReviewAnswers((current) => ({ ...current, [question.question_id]: { option_id: option.option_id } }))}
                        type="radio"
                      />
                      <span className="flex-1">{option.label}</span>
                    </label>
                  ))}
                  {selectedOption?.kind === "custom_text" ? (
                    <textarea
                      className="min-h-20 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
                      disabled={isSubmittingReview}
                      maxLength={selectedOption.input?.max_length ?? 4000}
                      onChange={(event) => setReviewAnswers((current) => ({ ...current, [question.question_id]: { option_id: selectedOption.option_id, custom_text: event.target.value } }))}
                      placeholder="请输入你的偏好"
                      value={selected?.custom_text ?? ""}
                    />
                  ) : null}
                </fieldset>
              );
            })}
          </div>
          <Button className="mt-6 w-full rounded-xl" disabled={isSubmittingReview} onClick={() => void handleSubmitReview()} type="button">
            {isSubmittingReview ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
            提交并生成学习路线
          </Button>
        </div>
      ) : taskIsInFlight && agentRun ? (
        <div className="rounded-2xl border border-border/80 bg-background/65 p-5">
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
          <AgentRunProgress key={agentRun.id} runId={agentRun.id} />
        </div>
      ) : (
        <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            将使用已评分前测、当前学习画像和账户默认模型生成 6–12 个章节。
          </p>
          <Button className="h-11 shrink-0 rounded-xl px-5" disabled={isSubmitting} onClick={() => void handleGenerate()} type="button">
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
  return status === "queued" || status === "running" || status === "waiting_for_human";
}

function toDisplayError(error: unknown, fallback: string): string {
  if (error instanceof PlanningApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}
