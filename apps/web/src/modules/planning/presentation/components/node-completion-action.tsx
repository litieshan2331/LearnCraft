/**
 * 学习节点完成标记组件。
 *
 * 组件：
 * - NodeCompletionAction：记录用户完成节点的意愿，不检查前置章节或内容生成状态。
 */

"use client";

import { CheckCircle2, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/primitives/button";

import {
  markPlanNodeCompleted,
  PlanningApiError,
  type PlanNode,
} from "../api/planning-client";

export function NodeCompletionAction({
  node,
  onCompleted,
}: Readonly<{
  node: PlanNode;
  onCompleted: (nextNode: PlanNode) => void;
}>) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleComplete(): Promise<void> {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      onCompleted(await markPlanNodeCompleted(node.id));
    } catch (error) {
      setErrorMessage(error instanceof PlanningApiError ? error.message : "暂时无法记录完成状态。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mt-7 flex flex-wrap items-center gap-3 rounded-2xl bg-secondary/55 px-5 py-4">
      {node.status === "completed" ? (
        <p className="inline-flex items-center gap-2 text-sm text-primary"><CheckCircle2 aria-hidden className="size-4" />已标记完成</p>
      ) : (
        <Button className="rounded-xl" disabled={isSubmitting} onClick={() => void handleComplete()} type="button">
          {isSubmitting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <CheckCircle2 aria-hidden className="size-4" />}
          标记本章已完成
        </Button>
      )}
      <p className="text-xs text-muted-foreground">完成标记仅用于记录你的学习进度，不会限制其他章节或后测生成。</p>
      {errorMessage ? <p className="basis-full text-sm text-destructive">{errorMessage}</p> : null}
    </div>
  );
}
