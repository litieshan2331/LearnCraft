/**
 * Assessment 题集作答、提交和评分结果展示组件。
 *
 * 组件与函数：
 * - AssessmentViewer：加载题集与历史摘要，协调选择答案和提交评分。
 * - QuestionCard：展示提交前的单选题。
 * - AssessmentResult：展示提交后的总分、答案、解析、错题筛选和前测路线生成入口。
 * - getAttemptIdempotencyKey：复用一次提交及安全重试期间的幂等键。
 */

"use client";

import { AlertCircle, ArrowLeft, BookOpenCheck, CheckCircle2, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  AssessmentApiError,
  getAssessment,
  getAssessmentAttempt,
  getAssessmentAttempts,
  submitAssessmentAttempt,
  type Assessment,
  type AssessmentAttempt,
  type AssessmentAttemptSummary,
  type AssessmentItem,
} from "../api/assessment-client";
import {
  getLearningGoal,
  type LearningGoal,
} from "@/modules/profile/presentation/api/profile-client";
import { PlanGenerationAction } from "@/modules/planning/presentation/components/plan-generation-action";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";

export function AssessmentViewer({ assessmentId }: Readonly<{ assessmentId: string }>) {
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [goal, setGoal] = useState<LearningGoal | null>(null);
  const [attempt, setAttempt] = useState<AssessmentAttempt | null>(null);
  const [attempts, setAttempts] = useState<AssessmentAttemptSummary[]>([]);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showOnlyWrong, setShowOnlyWrong] = useState(false);
  const attemptIdempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let isActive = true;

    void Promise.all([getAssessment(assessmentId), getAssessmentAttempts(assessmentId)])
      .then(async ([nextAssessment, nextAttempts]) => ({
        assessment: nextAssessment,
        goal: await getLearningGoal(nextAssessment.goal_id).catch(() => null),
        attempts: nextAttempts,
        latestAttempt: nextAttempts[0]
          ? await getAssessmentAttempt(nextAttempts[0].id)
          : null,
      }))
      .then((result) => {
        if (isActive) {
          setAssessment(result.assessment);
          setGoal(result.goal);
          setAttempts(result.attempts);
          setAttempt(result.latestAttempt);
        }
      })
      .catch((error: unknown) => {
        if (isActive) {
          setErrorMessage(toDisplayError(error));
        }
      })
      .finally(() => {
        if (isActive) {
          setIsLoading(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [assessmentId]);

  const answeredCount = useMemo(
    () => Object.keys(selectedAnswers).length,
    [selectedAnswers],
  );
  const allAnswered = assessment !== null && answeredCount === assessment.items.length;

  async function handleSubmit(): Promise<void> {
    if (!assessment || !allAnswered || attempt) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await submitAssessmentAttempt(
        assessment.id,
        {
          answers: assessment.items.map((item) => ({
            assessment_item_id: item.id,
            selected_option_key: selectedAnswers[item.id] ?? "",
          })),
        },
        getAttemptIdempotencyKey(attemptIdempotencyKeyRef),
      );
      setAttempt(result);
      setAttempts([toAttemptSummary(result)]);
    } catch (error) {
      setErrorMessage(toDisplayError(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  const returnHref = assessment?.kind === "post_test" && assessment.plan_node_id
    ? `/plan-nodes/${assessment.plan_node_id}`
    : "/goals";
  const returnLabel = assessment?.kind === "post_test" ? "返回章节内容" : "返回学习目标列表";

  if (isLoading) {
    return <LoadingState />;
  }

  if (!assessment) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-12">
        <Alert className="rounded-none border-[#d9b4a9] bg-[#fff8f5] text-[#8b3f35]" variant="destructive">
          <AlertCircle aria-hidden className="size-4" />
          <AlertTitle className="text-[#8b3f35]">无法读取题集</AlertTitle>
          <AlertDescription className="mt-1 text-[#8b3f35]">{errorMessage ?? "题集不存在或你无权访问。"}</AlertDescription>
        </Alert>
        <Button asChild className="mt-6 rounded-none" variant="outline">
          <Link href="/goals"><ArrowLeft aria-hidden />返回学习目标</Link>
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground" href={returnHref}>
        <ArrowLeft aria-hidden className="size-4" />
        {returnLabel}
      </Link>

      <section className="mt-7 border border-border border-l-2 border-l-primary bg-card p-5 sm:p-8">
        <AssessmentHeader assessment={assessment} attempt={attempt} answeredCount={answeredCount} />

        {errorMessage ? (
          <Alert className="mt-7 rounded-none border-[#d9b4a9] bg-[#fff8f5] text-[#8b3f35]" variant="destructive">
            <AlertCircle aria-hidden className="size-4" />
            <AlertTitle className="text-[#8b3f35]">操作未完成</AlertTitle>
            <AlertDescription className="mt-1 text-[#8b3f35]">{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {attempt ? (
          <AssessmentResult
            attempt={attempt}
            attempts={attempts}
            activePlanId={goal?.active_learning_plan_id ?? null}
            goalId={assessment.goal_id}
            showPlanGeneration={assessment.kind === "diagnostic" && goal !== null}
            showOnlyWrong={showOnlyWrong}
            onToggleWrong={() => setShowOnlyWrong((current) => !current)}
          />
        ) : (
          <>
            <Alert className="mt-7 rounded-none border-border bg-background" variant="default">
              <AlertCircle aria-hidden className="size-4 text-primary" />
              <AlertTitle>提交前不会显示答案或解析</AlertTitle>
              <AlertDescription className="mt-1">
                请按当前理解完成全部题目。提交后，系统会保存你的作答并立即给出得分和逐题解析。
              </AlertDescription>
            </Alert>

            <div className="mt-8 grid min-w-0 gap-5">
              {assessment.items.map((item) => (
                <QuestionCard
                  item={item}
                  key={item.id}
                  selectedOptionKey={selectedAnswers[item.id]}
                  onSelect={(optionKey) => setSelectedAnswers((current) => ({ ...current, [item.id]: optionKey }))}
                />
              ))}
            </div>

            <div className="mt-8 flex flex-col-reverse gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">已选择 {answeredCount} / {assessment.items.length} 题。必须完成全部题目才可提交。</p>
              <Button className="h-10 rounded-none px-4" disabled={!allAnswered || isSubmitting} onClick={() => void handleSubmit()} type="button">
                {isSubmitting ? <LoaderCircle aria-hidden className="animate-spin" /> : <CheckCircle2 aria-hidden />}
                {isSubmitting ? "正在评分" : "提交并查看结果"}
              </Button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function AssessmentHeader({
  assessment,
  attempt,
  answeredCount,
}: Readonly<{ assessment: Assessment; attempt: AssessmentAttempt | null; answeredCount: number }>) {
  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-2xl">
        <div className="flex items-center gap-2 text-primary">
          <BookOpenCheck aria-hidden className="size-4" />
          <p className="text-xs tracking-[0.16em]">{attempt ? (assessment.kind === "post_test" ? "POSTTEST RESULT" : "DIAGNOSTIC RESULT") : (assessment.kind === "post_test" ? "POSTTEST READY" : "DIAGNOSTIC READY")}</p>
        </div>
        <h1 className="mt-3 font-heading text-3xl font-normal tracking-tight">{attempt ? (assessment.kind === "post_test" ? "你的节点后测结果" : "你的前测结果") : (assessment.kind === "post_test" ? "你的节点后测题集已准备好" : "你的前测题集已准备好")}</h1>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          {attempt
            ? "结果基于提交时保存的答案确定性评分，不会额外调用模型。"
            : `这份${assessment.kind === "post_test" ? "后测" : "前测"}包含 ${assessment.question_count} 道选择题，请按当前理解作答。`}
        </p>
      </div>
      <div className="grid grid-cols-2 divide-x divide-border border border-border bg-background text-center">
        <div className="px-4 py-3">
          <p className="text-[11px] tracking-[0.13em] text-muted-foreground">{attempt ? "SCORE" : "DIFFICULTY"}</p>
          <p className="mt-1 text-sm font-medium">{attempt ? `${attempt.score.score_percent}%` : assessment.difficulty === "hard" ? "困难" : "正常"}</p>
        </div>
        <div className="px-4 py-3">
          <p className="text-[11px] tracking-[0.13em] text-muted-foreground">{attempt ? "CORRECT" : "SELECTED"}</p>
          <p className="mt-1 text-sm font-medium">{attempt ? `${attempt.items.filter((item) => item.is_correct).length} / ${attempt.items.length}` : `${answeredCount} / ${assessment.items.length}`}</p>
        </div>
      </div>
    </div>
  );
}

function AssessmentResult({
  attempt,
  attempts,
  activePlanId,
  goalId,
  showPlanGeneration,
  showOnlyWrong,
  onToggleWrong,
}: Readonly<{
  attempt: AssessmentAttempt;
  attempts: AssessmentAttemptSummary[];
  activePlanId: string | null;
  goalId: string;
  showPlanGeneration: boolean;
  showOnlyWrong: boolean;
  onToggleWrong: () => void;
}>) {
  const items = showOnlyWrong ? attempt.items.filter((item) => !item.is_correct) : attempt.items;
  const wrongCount = attempt.items.filter((item) => !item.is_correct).length;

  return (
    <div className="mt-8">
      <div className="grid gap-4 border-y border-border py-5 sm:grid-cols-3">
        <ResultMetric label="总分" value={`${attempt.score.total_score} / ${attempt.score.max_score}`} />
        <ResultMetric label="正确题数" value={`${attempt.items.length - wrongCount} / ${attempt.items.length}`} />
        <ResultMetric label="错题数" value={String(wrongCount)} />
      </div>

      {showPlanGeneration ? <PlanGenerationAction activePlanId={activePlanId} goalId={goalId} /> : null}
      <div className="mt-7 flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs tracking-[0.16em] text-primary">ANSWER REVIEW</p>
          <h2 className="mt-2 font-heading text-2xl font-normal">逐题解析</h2>
        </div>
        <Button className="rounded-none" onClick={onToggleWrong} type="button" variant="outline">
          {showOnlyWrong ? "查看全部题目" : `只看错题（${wrongCount}）`}
        </Button>
      </div>

      {items.length > 0 ? (
        <div className="mt-5 grid min-w-0 gap-5">
          {items.map((item) => <ResultQuestionCard item={item} key={item.assessment_item_id} />)}
        </div>
      ) : (
        <div className="mt-5 border border-dashed border-border bg-background px-5 py-10 text-center text-sm text-muted-foreground">本次没有错题。</div>
      )}

      <section className="mt-8 border-t border-border pt-6">
        <p className="text-xs tracking-[0.16em] text-primary">ATTEMPT HISTORY</p>
        <h2 className="mt-2 font-heading text-2xl font-normal">作答记录</h2>
        <div className="mt-4 grid gap-3">
          {attempts.map((summary) => (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-background px-4 py-3 text-sm" key={summary.id}>
              <span>第 {summary.attempt_no} 次作答</span>
              <span className="text-muted-foreground">{summary.score_percent}% · {summary.wrong_count} 道错题</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ResultMetric({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div>
      <p className="text-xs tracking-[0.13em] text-muted-foreground">{label}</p>
      <p className="mt-2 font-heading text-2xl">{value}</p>
    </div>
  );
}

function QuestionCard({
  item,
  selectedOptionKey,
  onSelect,
}: Readonly<{
  item: AssessmentItem;
  selectedOptionKey: string | undefined;
  onSelect: (optionKey: string) => void;
}>) {
  return (
    <fieldset className="min-w-0 max-w-full border border-border bg-background p-5">
      <legend className="sr-only">第 {item.ordinal} 题</legend>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 gap-4">
          <span className="grid size-7 shrink-0 place-items-center border border-primary text-xs font-medium text-primary">{String(item.ordinal).padStart(2, "0")}</span>
          <AssessmentRichText className="min-w-0 flex-1 pt-0.5 leading-7" content={item.prompt} />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{item.max_score} 分</span>
      </div>

      <div className="mt-5 grid gap-2 pl-0 sm:pl-11">
        {item.options.map((option) => {
          const isSelected = selectedOptionKey === option.key;
          return (
            <label className={`flex cursor-pointer items-start gap-3 border px-4 py-3 text-sm leading-6 transition-colors ${isSelected ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/60"}`} key={option.key}>
              <input checked={isSelected} className="mt-1 accent-primary" name={`assessment-item-${item.id}`} onChange={() => onSelect(option.key)} type="radio" value={option.key} />
              <div className="min-w-0 flex-1"><strong className="mr-2 font-medium text-primary">{option.key}.</strong><AssessmentRichText className="mt-0.5" content={option.text} /></div>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function ResultQuestionCard({ item }: Readonly<{ item: AssessmentAttempt["items"][number] }>) {
  const selectedOption = item.options.find((option) => option.key === item.selected_option_key);
  const correctOption = item.options.find((option) => option.key === item.correct_option_key);
  return (
    <article className={`min-w-0 max-w-full border p-5 ${item.is_correct ? "border-primary/50 bg-primary/5" : "border-[#d9b4a9] bg-[#fff8f5]"}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 gap-4">
          <span className={`grid size-7 shrink-0 place-items-center border text-xs font-medium ${item.is_correct ? "border-primary text-primary" : "border-[#a94e43] text-[#a94e43]"}`}>{String(item.ordinal).padStart(2, "0")}</span>
          <AssessmentRichText className="min-w-0 flex-1 pt-0.5 leading-7" content={item.prompt} />
        </div>
        <span className={`text-sm font-medium ${item.is_correct ? "text-primary" : "text-[#a94e43]"}`}>{item.is_correct ? "回答正确" : "需要复习"}</span>
      </div>
      <div className="mt-5 grid gap-3 border-t border-current/15 pt-4 text-sm sm:grid-cols-2 sm:pl-11">
        <p><span className="text-muted-foreground">你的答案：</span>{item.selected_option_key}. {selectedOption?.text ?? "未知选项"}</p>
        <p><span className="text-muted-foreground">正确答案：</span>{item.correct_option_key}. {correctOption?.text ?? "未知选项"}</p>
      </div>
      <div className="mt-4 border-t border-current/15 pt-4 sm:pl-11">
        <p className="text-xs tracking-[0.13em] text-muted-foreground">解析</p>
        <AssessmentRichText className="mt-2 text-sm leading-7" content={item.explanation} />
      </div>
    </article>
  );
}

function LoadingState() {
  return (
    <main className="grid min-h-80 place-items-center px-6 text-center">
      <div>
        <LoaderCircle aria-hidden className="mx-auto size-5 animate-spin text-primary" />
        <p className="mt-4 text-sm text-muted-foreground">正在读取题集…</p>
      </div>
    </main>
  );
}

function getAttemptIdempotencyKey(reference: { current: string | null }): string {
  reference.current ??= crypto.randomUUID();
  return reference.current;
}

function toAttemptSummary(attempt: AssessmentAttempt): AssessmentAttemptSummary {
  return {
    id: attempt.id,
    assessment_id: attempt.assessment_id,
    attempt_no: attempt.attempt_no,
    status: attempt.status,
    score_percent: attempt.score.score_percent,
    wrong_count: attempt.items.filter((item) => !item.is_correct).length,
    submitted_at: attempt.submitted_at,
    graded_at: attempt.graded_at,
  };
}

function toDisplayError(error: unknown): string {
  if (error instanceof AssessmentApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "题集暂时无法读取，请稍后重试。";
}

function AssessmentRichText({
  content,
  className,
}: Readonly<{ content: string; className?: string }>) {
  const segments = normalizeAssessmentMarkdown(content).split(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g);

  return (
    <div className={className}>
      {segments.map((segment, index) => {
        if (index % 3 === 0) {
          return <AssessmentPlainText content={segment} key={`text-${index}`} />;
        }
        if (index % 3 === 1) {
          const code = segments[index + 1] ?? "";
          return (
            <AssessmentCodeBlock
              content={code}
              key={`code-${index}`}
              language={segment || null}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

function normalizeAssessmentMarkdown(content: string): string {
  if (content.includes("\n") || !content.includes("\\n") || !content.includes("```")) {
    return content;
  }

  let normalized = "";
  for (let index = 0; index < content.length;) {
    if (content.startsWith("\\r\\n", index)) {
      normalized += "\n";
      index += 4;
      continue;
    }
    if (content.startsWith("\\n", index)) {
      normalized += "\n";
      index += 2;
      continue;
    }
    if (content.startsWith("\\\\", index)) {
      normalized += "\\";
      index += 2;
      continue;
    }
    normalized += content[index];
    index += 1;
  }
  return normalized;
}

function AssessmentPlainText({ content }: Readonly<{ content: string }>) {
  const trimmedContent = content.trim();
  if (!trimmedContent) {
    return null;
  }

  return (
    <p>
      {trimmedContent.split("\n").map((line, index) => (
        <span key={`${index}-${line}`}>
          {index > 0 ? <br /> : null}
          {line}
        </span>
      ))}
    </p>
  );
}

function AssessmentCodeBlock({
  content,
  language,
}: Readonly<{ content: string; language: string | null }>) {
  return (
    <div className="max-w-full overflow-hidden border border-border bg-[#1e201b] text-[#f4f1e8]">
      {language ? <p className="border-b border-white/15 px-3 py-1.5 font-mono text-xs lowercase text-[#c9c6ba]">{language}</p> : null}
      <pre className="max-w-full overflow-x-auto p-4 font-mono text-sm leading-6"><code>{content}</code></pre>
    </div>
  );
}
