/**
 * 已生成前测题集的只读展示组件。
 *
 * 组件：
 * - AssessmentViewer：读取并展示题目，记录当前浏览器内的临时选项状态。
 * - QuestionCard：展示单道选择题、技能标签与临时选择控件。
 */

"use client";

import { AlertCircle, ArrowLeft, BookOpenCheck, CheckCircle2, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  AssessmentApiError,
  getAssessment,
  type Assessment,
  type AssessmentItem,
} from "../api/assessment-client";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";

export function AssessmentViewer({ assessmentId }: Readonly<{ assessmentId: string }>) {
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isActive = true;

    void getAssessment(assessmentId)
      .then((nextAssessment) => {
        if (isActive) {
          setAssessment(nextAssessment);
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
          <Link href="/onboarding"><ArrowLeft aria-hidden />返回学习起点</Link>
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground" href={`/goals/${assessment.goal_id}/assessment`}>
        <ArrowLeft aria-hidden className="size-4" />
        返回前测配置
      </Link>

      <section className="mt-7 border border-border border-l-2 border-l-primary bg-card p-5 sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 text-primary">
              <BookOpenCheck aria-hidden className="size-4" />
              <p className="text-xs tracking-[0.16em]">DIAGNOSTIC READY</p>
            </div>
            <h1 className="mt-3 font-heading text-3xl font-normal tracking-tight">你的前测题集已准备好</h1>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              这份前测包含 {assessment.question_count} 道选择题。请按当前理解作答，不需要刻意追求正确率。
            </p>
          </div>
          <div className="grid grid-cols-2 divide-x divide-border border border-border bg-background text-center">
            <div className="px-4 py-3">
              <p className="text-[11px] tracking-[0.13em] text-muted-foreground">DIFFICULTY</p>
              <p className="mt-1 text-sm font-medium">{assessment.difficulty === "hard" ? "困难" : "正常"}</p>
            </div>
            <div className="px-4 py-3">
              <p className="text-[11px] tracking-[0.13em] text-muted-foreground">SELECTED</p>
              <p className="mt-1 text-sm font-medium">{answeredCount} / {assessment.items.length}</p>
            </div>
          </div>
        </div>

        <Alert className="mt-7 rounded-none border-border bg-background" variant="default">
          <AlertCircle aria-hidden className="size-4 text-primary" />
          <AlertTitle>当前为题集展示阶段</AlertTitle>
          <AlertDescription className="mt-1">
            选择会暂存在当前浏览器，用于浏览进度；P0 尚未接入作答提交和评分接口，因此不会保存答案或显示分数。
          </AlertDescription>
        </Alert>

        <div className="mt-8 grid gap-5">
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
          <p className="text-sm text-muted-foreground">已选择 {answeredCount} / {assessment.items.length} 题。作答与评分能力将在后续迭代接入。</p>
          <Button asChild className="h-10 rounded-none px-4" variant="outline">
            <Link href="/onboarding"><CheckCircle2 aria-hidden />返回学习起点</Link>
          </Button>
        </div>
      </section>
    </main>
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
    <fieldset className="border border-border bg-background p-5">
      <legend className="sr-only">第 {item.ordinal} 题</legend>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-4">
          <span className="grid size-7 shrink-0 place-items-center border border-primary text-xs font-medium text-primary">
            {String(item.ordinal).padStart(2, "0")}
          </span>
          <p className="pt-0.5 leading-7">{item.prompt}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{item.max_score} 分</span>
      </div>

      <div className="mt-5 grid gap-2 pl-0 sm:pl-11">
        {item.options.map((option) => {
          const isSelected = selectedOptionKey === option.key;
          return (
            <label
              className={`flex cursor-pointer items-start gap-3 border px-4 py-3 text-sm leading-6 transition-colors ${isSelected ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/60"}`}
              key={option.key}
            >
              <input
                checked={isSelected}
                className="mt-1 accent-primary"
                name={`assessment-item-${item.id}`}
                onChange={() => onSelect(option.key)}
                type="radio"
                value={option.key}
              />
              <span><strong className="mr-2 font-medium text-primary">{option.key}.</strong>{option.text}</span>
            </label>
          );
        })}
      </div>

      {item.skill_tags.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2 sm:pl-11">
          {item.skill_tags.map((tag) => (
            <span className="border border-border px-2 py-0.5 text-xs text-muted-foreground" key={tag}>{tag}</span>
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}

function LoadingState() {
  return (
    <main className="grid min-h-80 place-items-center px-6 text-center">
      <div>
        <LoaderCircle aria-hidden className="mx-auto size-5 animate-spin text-primary" />
        <p className="mt-4 text-sm text-muted-foreground">正在读取前测题集…</p>
      </div>
    </main>
  );
}

function toDisplayError(error: unknown): string {
  if (error instanceof AssessmentApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "题集暂时无法读取，请稍后重试。";
}
