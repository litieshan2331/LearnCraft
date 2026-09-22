/**
 * 节点知识内容生成操作组件。
 *
 * 组件与函数：
 * - CardContentGenerationAction：创建 card_content_generate 任务并轮询其状态；
 *   刷新页面后本地没有 run 对象，改用节点返回的「在途 run id」接上同一个任务，继续展示真实进度。
 * - isInFlight：判断节点内容任务是否仍在执行。
 * - toDisplayError：将安全接口错误转换为用户可读文案。
 */

"use client";

import { AlertCircle, BookOpenText, LoaderCircle, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentRunProgress } from "@/modules/agent-run/presentation/components/agent-run-progress";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";

import {
  ContentApiError,
  createCardContentGenerationRun,
  getCardContentGenerationRun,
  type CardContentGenerationRun,
} from "../api/content-client";

const POLL_INTERVAL_MS = 2_000;

export function CardContentGenerationAction({
  planNodeId,
  contentStatus,
  inFlightRunId,
  onCompleted,
}: Readonly<{
  planNodeId: string;
  contentStatus: string;
  /** 节点在读接口里带出的在途 run id；刷新页面后靠它恢复进度展示，没有在途任务时为 null。 */
  inFlightRunId: string | null;
  onCompleted: () => void | Promise<void>;
}>) {
  const [agentRun, setAgentRun] = useState<CardContentGenerationRun | null>(null);
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

    const schedulePoll = (): void => {
      if (active) {
        timeoutId = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };

    const poll = async (): Promise<void> => {
      try {
        const latestRun = await getCardContentGenerationRun(activeRunId);
        if (!active) {
          return;
        }
        if (latestRun.status === "succeeded") {
          setErrorMessage(null);
          await onCompleted();
          if (active) {
            setAgentRun(latestRun);
          }
          return;
        }
        setAgentRun(latestRun);
        if (latestRun.status === "failed") {
          setErrorMessage(latestRun.error?.message ?? "节点知识内容生成失败，请重新发起。");
          return;
        }
        if (latestRun.status === "cancelled" || latestRun.status === "expired") {
          setErrorMessage("节点知识内容生成任务已结束，请重新发起。");
          return;
        }
      } catch (error) {
        if (active) {
          setErrorMessage(toDisplayError(error, "节点知识内容任务状态暂时无法读取。"));
          schedulePoll();
        }
        return;
      }

      schedulePoll();
    };

    void poll();

    return () => {
      active = false;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activeRunId, activeRunStatus, onCompleted]);

  useEffect(() => {
    if (contentStatus !== "generating" || agentRun) {
      return;
    }

    let active = true;
    let timeoutId: number | undefined;

    const pollNode = async (): Promise<void> => {
      try {
        await onCompleted();
      } catch (error) {
        if (active) {
          setErrorMessage(toDisplayError(error, "节点知识内容状态暂时无法读取。"));
        }
      }
      if (active) {
        timeoutId = window.setTimeout(() => void pollNode(), POLL_INTERVAL_MS);
      }
    };

    void pollNode();
    return () => {
      active = false;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [agentRun, contentStatus, onCompleted]);

  // 刷新后本地没有 run 对象：用节点带来的在途 run id 取回同一个任务，
  // 之后上面的轮询与进度面板照常工作；失败时退回静态「正在生成」面板 + 节点轮询。
  useEffect(() => {
    if (agentRun || !inFlightRunId || contentStatus !== "generating") {
      return;
    }

    let active = true;
    void getCardContentGenerationRun(inFlightRunId)
      .then(async (latestRun) => {
        if (!active) {
          return;
        }
        if (latestRun.status === "succeeded") {
          await onCompleted();
          if (active) {
            setAgentRun(latestRun);
          }
          return;
        }
        if (latestRun.status === "failed") {
          setAgentRun(latestRun);
          setErrorMessage(latestRun.error?.message ?? "节点知识内容生成失败，请重新发起。");
          return;
        }
        if (latestRun.status === "cancelled" || latestRun.status === "expired") {
          setAgentRun(latestRun);
          setErrorMessage("节点知识内容生成任务已结束，请重新发起。");
          return;
        }
        setAgentRun(latestRun);
      })
      .catch(() => {
        // 读不到就退回静态面板，不打断页面。
      });

    return () => {
      active = false;
    };
  }, [agentRun, contentStatus, inFlightRunId, onCompleted]);

  async function handleGenerate(): Promise<void> {
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      setAgentRun(await createCardContentGenerationRun(planNodeId, crypto.randomUUID()));
    } catch (error) {
      setErrorMessage(toDisplayError(error, "节点知识内容任务暂时无法创建。"));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (contentStatus === "ready") {
    return (
      <section className="mt-7 rounded-[1.25rem] border border-primary/25 bg-primary/[0.07] p-5 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.4)]">
        <p className="inline-flex items-center gap-2 font-medium text-primary"><BookOpenText aria-hidden className="size-4" />节点知识内容已准备好</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">知识内容阅读视图将在内容结果回写完成后展示。</p>
      </section>
    );
  }

  if (contentStatus === "generating" && !agentRun) {
    return (
      <section className="mt-7 rounded-2xl border border-border/80 bg-background/65 p-5">
        <p className="inline-flex items-center gap-2 font-medium"><LoaderCircle aria-hidden className="size-4 animate-spin text-primary" />节点知识内容正在生成</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">任务已在后台执行，页面会自动检查完成状态。</p>
      </section>
    );
  }

  return (
    <section className="mt-7 rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] p-5 sm:p-7">
      {errorMessage ? (
        <Alert className="mb-5 rounded-xl border-destructive/25 bg-destructive/5 text-destructive" variant="destructive">
          <AlertCircle aria-hidden className="size-4" />
          <AlertTitle className="text-destructive">节点知识内容未能完成</AlertTitle>
          <AlertDescription className="mt-1 text-destructive">{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {taskIsInFlight && agentRun ? (
        <div className="rounded-2xl border border-border/80 bg-background/65 p-5">
          <div className="flex items-start gap-3">
            <LoaderCircle aria-hidden className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
            <div>
              <p className="font-medium">{agentRun.status === "queued" ? "正在等待节点内容生成" : "正在生成节点知识内容"}</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Node Tutor 正在组织知识讲解、示例、易错点和可追溯引用，完成后会自动刷新本页。
              </p>
            </div>
          </div>
          <div className="mt-5 h-px overflow-hidden bg-border"><div className="h-full w-2/5 animate-pulse bg-primary" /></div>
          <AgentRunProgress key={agentRun.id} runId={agentRun.id} />
        </div>
      ) : (
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            将使用当前章节、学习目标、画像和账户默认模型生成唯一的节点知识内容。
          </p>
          <Button className="h-11 shrink-0 rounded-xl px-5" disabled={isSubmitting} onClick={() => void handleGenerate()} type="button">
            {isSubmitting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <Sparkles aria-hidden className="size-4" />}
            {contentStatus === "failed" || agentRun ? "重新生成节点内容" : "生成节点内容"}
          </Button>
        </div>
      )}
    </section>
  );
}

function isInFlight(status: CardContentGenerationRun["status"]): boolean {
  return status === "queued" || status === "running";
}

function toDisplayError(error: unknown, fallback: string): string {
  if (error instanceof ContentApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}
