/**
 * 节点后测生成操作组件。
 *
 * 组件：
 * - PosttestGenerationAction：创建并轮询 posttest_generate AgentRun，成功后跳转后测题集。
 */

"use client";

import { AlertCircle, ArrowRight, LoaderCircle, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AssessmentApiError, createPosttestRun, getAgentRun, type AgentRun, type AssessmentDifficulty, type PosttestAssessmentSummary } from "../api/assessment-client";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";

const POLL_INTERVAL_MS = 2_000;

export function PosttestGenerationAction({
  planNodeId,
  contentReady,
  existingAssessment,
}: Readonly<{ planNodeId: string; contentReady: boolean; existingAssessment: PosttestAssessmentSummary | null }>) {
  const router = useRouter();
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [questionCount, setQuestionCount] = useState(6);
  const [difficulty, setDifficulty] = useState<AssessmentDifficulty>("normal");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const runId = agentRun?.id ?? null;
  const runStatus = agentRun?.status ?? null;

  useEffect(() => {
    if (!runId || !runStatus || !isInFlight(runStatus)) return;
    let active = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const latest = await getAgentRun(runId);
        if (!active) return;
        setAgentRun(latest);
        if (latest.status === "succeeded") {
          const assessmentId = latest.assessment_result?.assessment_id;
          if (assessmentId) {
            router.replace("/assessments/" + assessmentId);
            return;
          }
          setErrorMessage("后测已生成，但未返回题集编号。请重新发起。");
          return;
        }
        if (latest.status === "failed") {
          setErrorMessage(latest.error?.message ?? "后测生成失败，请重新发起。");
          return;
        }
        if (latest.status === "cancelled" || latest.status === "expired") {
          setErrorMessage("后测生成任务已结束，请重新发起。");
          return;
        }
      } catch (error) {
        if (active) setErrorMessage(toDisplayError(error));
        return;
      }
      if (active) timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runId, runStatus, router]);

  async function handleGenerate(): Promise<void> {
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      const nextRun = await createPosttestRun(
        planNodeId,
        { question_count: questionCount, difficulty },
        crypto.randomUUID(),
      );
      setAgentRun(nextRun);
      if (nextRun.status === "succeeded") {
        const assessmentId = nextRun.assessment_result?.assessment_id;
        if (assessmentId) {
          router.replace("/assessments/" + assessmentId);
        } else {
          setErrorMessage("后测已生成，但未返回题集编号。请重新发起。");
        }
      } else if (nextRun.status === "failed") {
        setErrorMessage(nextRun.error?.message ?? "后测生成失败，请重新发起。");
      }
    } catch (error) {
      setErrorMessage(toDisplayError(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!contentReady) {
    return <p className="mt-6 text-sm text-muted-foreground">生成节点知识内容后，才可以生成本章后测。</p>;
  }

  if (existingAssessment && (existingAssessment.status === "ready" || existingAssessment.status === "graded")) {
    const hasAttempt = existingAssessment.latest_attempt !== null;
    return (
      <section className="mt-7 border border-border bg-card p-5 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs tracking-[0.14em] text-primary">POSTTEST</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {hasAttempt
                ? `本章后测已完成，得分 ${existingAssessment.latest_attempt?.score_percent ?? 0}% 。`
                : `本章后测已准备好，共 ${existingAssessment.question_count} 道选择题。`}
            </p>
          </div>
          <Button asChild className="rounded-none">
            <Link href={`/assessments/${existingAssessment.assessment_id}`}>
              {hasAttempt ? "查看后测结果" : "查看后测题集"}
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </Button>
        </div>
      </section>
    );
  }
  if (agentRun && isInFlight(agentRun.status)) {
    return (
      <section className="mt-7 border border-border bg-background p-5">
        <div className="flex items-center gap-3">
          <LoaderCircle aria-hidden className="size-5 animate-spin text-primary" />
          <div>
            <p className="font-medium">正在生成本章后测</p>
            <p className="mt-1 text-sm text-muted-foreground">Node Tutor 正在基于本章知识内容和教学记忆组织题目。</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-7 border border-border bg-card p-5 sm:p-7">
      {errorMessage ? (
        <Alert className="mb-5 rounded-none border-[#d9b4a9] bg-[#fff8f5] text-[#8b3f35]" variant="destructive">
          <AlertCircle aria-hidden className="size-4" />
          <AlertTitle className="text-[#8b3f35]">后测未能完成</AlertTitle>
          <AlertDescription className="mt-1 text-[#8b3f35]">{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs tracking-[0.14em] text-primary">POSTTEST</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">基于已生成的本章内容生成 5–10 道选择题。</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm">题量
            <select className="ml-2 border border-border bg-background px-2 py-2" onChange={(event) => setQuestionCount(Number(event.target.value))} value={questionCount}>
              {[5, 6, 7, 8, 9, 10].map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>
          <label className="text-sm">难度
            <select className="ml-2 border border-border bg-background px-2 py-2" onChange={(event) => setDifficulty(event.target.value as AssessmentDifficulty)} value={difficulty}>
              <option value="normal">正常</option>
              <option value="hard">困难</option>
            </select>
          </label>
          <Button className="rounded-none" disabled={isSubmitting} onClick={() => void handleGenerate()} type="button">
            {isSubmitting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <Sparkles aria-hidden className="size-4" />}
            生成后测
          </Button>
        </div>
      </div>
    </section>
  );
}

function isInFlight(status: AgentRun["status"]): boolean {
  return status === "queued" || status === "running";
}

function toDisplayError(error: unknown): string {
  if (error instanceof AssessmentApiError) return error.message;
  return error instanceof Error ? error.message : "后测任务暂时无法完成，请稍后重试。";
}
