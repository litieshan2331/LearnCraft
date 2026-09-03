/**
 * 单个模型连接的展示与操作卡片。
 *
 * 组件：
 * - ModelConnectionCard：展示安全连接摘要，并提供编辑、设为默认和删除交互。
 */

"use client";

import { Check, CircleAlert, Pencil, Star, Trash2 } from "lucide-react";
import { useState } from "react";

import { ModelConnectionForm } from "./model-connection-form";
import type {
  ModelConnection,
  UpdateModelConnectionRequest,
} from "../api/model-connection-client";
import { Button } from "@/shared/ui/primitives/button";

interface ModelConnectionCardProps {
  connection: ModelConnection;
  isMutating: boolean;
  onDelete: () => Promise<void>;
  onSetDefault: () => Promise<void>;
  onUpdate: (input: UpdateModelConnectionRequest) => Promise<void>;
}

export function ModelConnectionCard({
  connection,
  isMutating,
  onDelete,
  onSetDefault,
  onUpdate,
}: Readonly<ModelConnectionCardProps>) {
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleSetDefault(): Promise<void> {
    setActionError(null);
    try {
      await onSetDefault();
    } catch {
      setActionError("设为默认连接失败，请稍后重试。");
    }
  }

  async function handleDelete(): Promise<void> {
    setActionError(null);
    try {
      await onDelete();
    } catch {
      setActionError("删除连接失败，请稍后重试。");
    }
  }

  if (isEditing) {
    return (
      <article className="rounded-[1.25rem] border border-border/80 bg-card/85 p-5 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] sm:p-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs tracking-[0.16em] text-primary">EDIT CONNECTION</p>
            <h2 className="mt-2 font-heading text-2xl font-medium">编辑 {connection.display_name}</h2>
          </div>
        </div>
        <ModelConnectionForm
          connection={connection}
          onCancel={() => setIsEditing(false)}
          onUpdate={async (input) => {
            await onUpdate(input);
            setIsEditing(false);
          }}
        />
      </article>
    );
  }

  return (
    <article className="rounded-[1.25rem] border border-border/80 bg-card/85 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] transition-all hover:-translate-y-0.5 hover:border-primary/35">
      <div className="flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-heading text-2xl font-medium tracking-tight">{connection.display_name}</h2>
              {connection.is_default ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/35 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                  <Star aria-hidden className="size-3 fill-current" />
                  账户默认
                </span>
              ) : null}
              <ConnectionStatus status={connection.status} />
            </div>
            <p className="mt-2 text-xs tracking-[0.12em] text-muted-foreground">OPENAI-COMPATIBLE</p>
          </div>
          <div className="flex items-center gap-1 self-start">
            <Button
              aria-label={`编辑 ${connection.display_name}`}
              className="rounded-xl"
              disabled={isMutating}
              onClick={() => setIsEditing(true)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Pencil aria-hidden />
            </Button>
            <Button
              aria-label={`删除 ${connection.display_name}`}
              className="rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={isMutating}
              onClick={() => setIsConfirmingDelete(true)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        </div>

        <dl className="grid gap-4 rounded-2xl bg-secondary/55 p-4 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <dt className="text-xs tracking-[0.1em] text-muted-foreground">MODEL</dt>
            <dd className="mt-1.5 truncate font-mono text-foreground" title={connection.default_model_id}>
              {connection.default_model_id}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs tracking-[0.1em] text-muted-foreground">BASE URL</dt>
            <dd className="mt-1.5 truncate font-mono text-foreground" title={connection.base_url}>
              {connection.base_url}
            </dd>
          </div>
        </dl>

        {actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}

        {isConfirmingDelete ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-6 text-foreground">删除后无法恢复已保存的 API Key；历史运行记录会保留安全摘要。</p>
            <div className="flex shrink-0 gap-2">
              <Button className="rounded-xl" disabled={isMutating} onClick={() => setIsConfirmingDelete(false)} size="sm" type="button" variant="ghost">
                取消
              </Button>
              <Button className="rounded-xl" disabled={isMutating} onClick={() => void handleDelete()} size="sm" type="button" variant="destructive">
                删除
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs leading-5 text-muted-foreground">API Key 已加密保存且不会在此处显示。连接将在生成任务执行时使用。</p>
            {!connection.is_default ? (
              <Button className="h-9 rounded-xl" disabled={isMutating || connection.status !== "active"} onClick={() => void handleSetDefault()} size="sm" type="button" variant="outline">
                <Star aria-hidden />
                设为默认
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}

function ConnectionStatus({ status }: Readonly<{ status: ModelConnection["status"] }>) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-primary">
        <Check aria-hidden className="size-3" />
        已保存
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs text-destructive">
      <CircleAlert aria-hidden className="size-3" />
      {status === "invalid" ? "需要更新" : "已停用"}
    </span>
  );
}
