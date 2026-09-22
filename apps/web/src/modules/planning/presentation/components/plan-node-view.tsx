/**
 * 学习章节详情展示组件。
 *
 * 组件与函数：
 * - PlanNodeView：读取章节详情，并发起或观察节点知识内容生成任务。
 * - formatStatus：将稳定状态值转换为中文展示文案。
 */

"use client";

import { AlertCircle, ArrowLeft, BookOpen, Clock3, LoaderCircle, Target } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { CardContentGenerationAction } from "@/modules/content/presentation/components/card-content-generation-action";
import { CardContentView } from "@/modules/content/presentation/components/card-content-view";
import { NodeCompletionAction } from "./node-completion-action";
import { PosttestGenerationAction } from "@/modules/assessment/presentation/components/posttest-generation-action";
import { getPosttestAssessmentAttempts, getPosttestAssessments, type PosttestAssessmentAttemptRecord, type PosttestAssessmentSummary } from "@/modules/assessment/presentation/api/assessment-client";
import { getCardContent, type CardContent } from "@/modules/content/presentation/api/content-client";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";

import {
  getPlanNode,
  PlanningApiError,
  type PlanNode,
} from "../api/planning-client";

export function PlanNodeView({ nodeId }: Readonly<{ nodeId: string }>) {
  const [node, setNode] = useState<PlanNode | null>(null);
  const [content, setContent] = useState<CardContent | null>(null);
  const [posttests, setPosttests] = useState<PosttestAssessmentSummary[]>([]);
  const [posttestAttempts, setPosttestAttempts] = useState<PosttestAssessmentAttemptRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getPlanNode(nodeId)
      .then((nextNode) => {
        if (active) {
          setContent(null);
          setPosttests([]);
          setNode(nextNode);
        }
      })
      .catch((requestError: unknown) => {
        if (active) {
          setError(requestError instanceof PlanningApiError ? requestError.message : "学习章节暂时无法读取，请稍后重试。");
        }
      });

    return () => {
      active = false;
    };
  }, [nodeId]);
  useEffect(() => {
    if (!node?.card_content_id) {
      return;
    }

    let active = true;
    void getCardContent(node.card_content_id)
      .then((nextContent) => {
        if (active) {
          setContent(nextContent);
        }
      })
      .catch(() => {
        if (active) {
          setContent(null);
        }
      });

    return () => {
      active = false;
    };
  }, [node?.card_content_id]);
  useEffect(() => {
    if (!node?.id) {
      return;
    }

    let active = true;
    void Promise.all([
      getPosttestAssessments(node.id),
      getPosttestAssessmentAttempts(node.id),
    ])
      .then(([items, attempts]) => {
        if (active) {
          setPosttests(items);
          setPosttestAttempts(attempts);
        }
      })
      .catch(() => {
        if (active) {
          setPosttests([]);
          setPosttestAttempts([]);
        }
      });

    return () => {
      active = false;
    };
  }, [node?.id]);
  const refreshNode = useCallback(async (): Promise<void> => {
    const nextNode = await getPlanNode(nodeId);
    setNode(nextNode);
  }, [nodeId]);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10">
        <Alert className="rounded-xl border-destructive/25 bg-destructive/5 text-destructive" variant="destructive">
          <AlertCircle aria-hidden className="size-4" />
          <AlertTitle className="text-destructive">无法读取学习章节</AlertTitle>
          <AlertDescription className="mt-1 text-destructive">{error}</AlertDescription>
        </Alert>
        <Button asChild className="mt-6 rounded-xl" variant="outline">
          <Link href="/goals"><ArrowLeft aria-hidden className="size-4" />返回学习目标</Link>
        </Button>
      </main>
    );
  }

  if (!node) {
    return <div className="grid min-h-96 place-items-center"><LoaderCircle aria-hidden className="size-5 animate-spin text-primary" /></div>;
  }

  const prerequisiteLabel = node.prerequisite_node_ids.length > 0
    ? String(node.prerequisite_node_ids.length) + " 个前置章节"
    : "无前置章节";

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10">
      <Button asChild className="rounded-xl" variant="ghost">
        <Link href={"/learning-plans/" + node.plan_id}><ArrowLeft aria-hidden className="size-4" />返回学习路线</Link>
      </Button>

      <header className="mt-7 rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] p-6 sm:p-9">
        <div className="flex flex-wrap items-center gap-3 text-xs tracking-[0.16em] text-primary">
          <span className="inline-flex items-center gap-2"><BookOpen aria-hidden className="size-4" />{node.plan_title}</span>
          <span className="rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">第 {node.ordinal} 章</span>
          <span className="rounded-full bg-primary/10 px-2.5 py-1 text-primary">{formatStatus(node.status)}</span>
        </div>
        <h1 className="mt-4 font-heading text-4xl font-medium tracking-tight">{node.title}</h1>
        <p className="mt-5 max-w-3xl text-sm leading-8 text-muted-foreground">{node.node_brief}</p>
      </header>

      <section className="mt-8 grid gap-5 sm:grid-cols-2">
        <article className="rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] p-5">
          <p className="inline-flex items-center gap-2 text-xs tracking-[0.14em] text-primary"><Target aria-hidden className="size-4" />LEARNING OBJECTIVE</p>
          <p className="mt-4 leading-8">{node.learning_objective}</p>
        </article>
        <article className="rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] p-5">
          <p className="inline-flex items-center gap-2 text-xs tracking-[0.14em] text-primary"><Clock3 aria-hidden className="size-4" />STUDY ESTIMATE</p>
          <p className="mt-4 text-lg">{node.estimated_minutes} 分钟</p>
          <p className="mt-2 text-sm text-muted-foreground">难度 {node.difficulty}/5 · {prerequisiteLabel}</p>
        </article>
      </section>

      <section className="mt-5 rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] p-5 sm:p-7">
        <p className="text-xs tracking-[0.14em] text-primary">COMPLETION CRITERIA</p>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-7">
          {node.completion_criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
        </ul>
      </section>

      {node.rationale ? (
        <section className="mt-5 rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] p-5 sm:p-7">
          <p className="text-xs tracking-[0.14em] text-primary">WHY THIS CHAPTER</p>
          <p className="mt-4 text-sm leading-7 text-muted-foreground">{node.rationale}</p>
        </section>
      ) : null}

      <CardContentGenerationAction
        contentStatus={node.content_status}
        inFlightRunId={node.latest_content_run_id}
        onCompleted={refreshNode}
        planNodeId={node.id}
      />
      <NodeCompletionAction node={node} onCompleted={(nextNode) => setNode(nextNode)} />
      <PosttestGenerationAction contentReady={Boolean(node.card_content_id)} existingAssessment={posttests[0] ?? null} inFlightRunId={node.latest_posttest_run_id} planNodeId={node.id} posttestAttempts={posttestAttempts} />
      {content ? <CardContentView content={content} /> : null}

    </main>
  );
}

function formatStatus(value: string): string {
  const labels: Record<string, string> = {
    active: "进行中",
    available: "可学习",
    in_progress: "学习中",
    completed: "已完成",
    needs_review: "需复习",
    generating: "生成中",
    ready: "已准备",
    not_requested: "未请求",
    failed: "生成失败",
    superseded: "历史版本",
  };
  return labels[value] ?? value;
}
