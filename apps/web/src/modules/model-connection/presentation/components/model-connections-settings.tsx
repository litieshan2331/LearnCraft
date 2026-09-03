/**
 * 模型连接设置页的状态容器。
 *
 * 组件：
 * - ModelConnectionsSettings：加载连接列表，并协调创建、更新、设默认、删除等页面交互。
 */

"use client";

import { AlertCircle, LoaderCircle, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ModelConnectionCard } from "./model-connection-card";
import { ModelConnectionForm } from "./model-connection-form";
import {
  createModelConnection,
  deleteModelConnection,
  listModelConnections,
  setDefaultModelConnection,
  updateModelConnection,
  type CreateModelConnectionRequest,
  type ModelConnection,
  type UpdateModelConnectionRequest,
} from "../api/model-connection-client";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";

export function ModelConnectionsSettings() {
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [mutatingConnectionId, setMutatingConnectionId] = useState<string | null>(null);

  const loadConnections = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setLoadError(null);

    try {
      const nextConnections = await listModelConnections();
      setConnections(nextConnections);
    } catch {
      setLoadError("暂时无法读取模型连接，请检查网络后重试。");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let isActive = true;

    void listModelConnections()
      .then((nextConnections) => {
        if (isActive) {
          setConnections(nextConnections);
        }
      })
      .catch(() => {
        if (isActive) {
          setLoadError("暂时无法读取模型连接，请检查网络后重试。");
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
  }, []);

  async function handleCreate(input: CreateModelConnectionRequest): Promise<void> {
    const created = await createModelConnection(input);
    setConnections((current) => sortConnections([...current.filter((item) => item.id !== created.id), created]));
    setIsCreateFormOpen(false);
  }

  async function handleUpdate(
    connectionId: string,
    input: UpdateModelConnectionRequest,
  ): Promise<void> {
    setMutatingConnectionId(connectionId);
    try {
      const updated = await updateModelConnection(connectionId, input);
      setConnections((current) => sortConnections(current.map((item) => item.id === updated.id ? updated : item)));
    } finally {
      setMutatingConnectionId(null);
    }
  }

  async function handleSetDefault(connectionId: string): Promise<void> {
    setMutatingConnectionId(connectionId);
    try {
      const updated = await setDefaultModelConnection(connectionId);
      setConnections((current) => sortConnections(current.map((item) => {
        if (item.id === updated.id) {
          return updated;
        }
        return { ...item, is_default: false };
      })));
    } finally {
      setMutatingConnectionId(null);
    }
  }

  async function handleDelete(connectionId: string): Promise<void> {
    setMutatingConnectionId(connectionId);
    try {
      await deleteModelConnection(connectionId);
      setConnections((current) => current.filter((item) => item.id !== connectionId));
    } finally {
      setMutatingConnectionId(null);
    }
  }

  return (
    <div className="mt-6">
      <section className="rounded-[1.25rem] border border-border/80 bg-card/85 p-5 shadow-[0_18px_50px_-42px_rgba(23,53,58,0.5)] sm:p-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 text-primary">
              <ShieldCheck aria-hidden className="size-4" />
              <p className="text-xs tracking-[0.16em]">PRIVATE BY DESIGN</p>
            </div>
            <h2 className="mt-3 font-heading text-2xl font-medium tracking-tight">你掌握模型与费用的选择权</h2>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              保存 OpenAI-compatible Provider 的连接。API Key 在服务端加密保存，列表和编辑页面都不会回显它。
            </p>
          </div>
          <Button
            className="h-11 shrink-0 rounded-xl px-5"
            disabled={isLoading}
            onClick={() => setIsCreateFormOpen((current) => !current)}
            type="button"
          >
            {isCreateFormOpen ? null : <Plus aria-hidden />}
            {isCreateFormOpen ? "收起表单" : "添加连接"}
          </Button>
        </div>

        {isCreateFormOpen ? (
          <div className="mt-7 rounded-2xl bg-secondary/55 p-5">
            <p className="text-xs tracking-[0.16em] text-primary">NEW CONNECTION</p>
            <h3 className="mt-2 font-heading text-xl font-medium">添加你的模型连接</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">DeepSeek、Qwen 等兼容 OpenAI 协议的服务均可在这里配置。</p>
            <div className="mt-6">
              <ModelConnectionForm
                onCancel={() => setIsCreateFormOpen(false)}
                onCreate={handleCreate}
              />
            </div>
          </div>
        ) : null}
      </section>

      <section className="mt-8" aria-labelledby="saved-connections-heading">
        <div className="flex items-end justify-between gap-4 px-1">
          <div>
            <p className="text-xs tracking-[0.16em] text-primary">SAVED CONNECTIONS</p>
            <h2 className="mt-2 font-heading text-3xl font-medium tracking-tight" id="saved-connections-heading">已保存的连接</h2>
          </div>
          <Button
            aria-label="刷新模型连接列表"
            className="size-10 rounded-xl border border-border bg-card/80 hover:bg-secondary"
            disabled={isLoading}
            onClick={() => void loadConnections()}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden className={isLoading ? "animate-spin" : ""} />
          </Button>
        </div>

        {isLoading ? <LoadingState /> : null}
        {!isLoading && loadError ? (
          <Alert className="mt-5 rounded-xl border-destructive/25 bg-destructive/5 text-destructive" variant="destructive">
            <AlertCircle aria-hidden className="size-4" />
            <AlertTitle className="text-destructive">无法加载连接</AlertTitle>
            <AlertDescription className="mt-1 text-destructive">{loadError}</AlertDescription>
          </Alert>
        ) : null}
        {!isLoading && !loadError && connections.length === 0 ? (
          <EmptyState onCreate={() => setIsCreateFormOpen(true)} />
        ) : null}
        {!isLoading && !loadError && connections.length > 0 ? (
          <div className="mt-5 grid gap-4">
            {connections.map((connection) => (
              <ModelConnectionCard
                connection={connection}
                isMutating={mutatingConnectionId === connection.id}
                key={connection.id}
                onDelete={() => handleDelete(connection.id)}
                onSetDefault={() => handleSetDefault(connection.id)}
                onUpdate={(input) => handleUpdate(connection.id, input)}
              />
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="mt-5 rounded-[1.25rem] border border-border/80 bg-card/70 px-6 py-14 text-center">
      <LoaderCircle aria-hidden className="size-5 animate-spin text-primary" />
      <p className="mt-3 text-sm text-muted-foreground">正在读取你的模型连接…</p>
    </div>
  );
}

function EmptyState({ onCreate }: Readonly<{ onCreate: () => void }>) {
  return (
    <div className="mt-5 rounded-[1.25rem] border border-dashed border-primary/25 bg-card/70 px-6 py-14 text-center">
      <p className="font-heading text-2xl font-medium">还没有模型连接</p>
      <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-muted-foreground">
        添加第一个 OpenAI-compatible 连接后，后续可将它设为账户默认，或为每个学习目标单独选择。
      </p>
      <Button className="mt-6 h-11 rounded-xl px-5" onClick={onCreate} type="button">
        <Plus aria-hidden />
        添加第一个连接
      </Button>
    </div>
  );
}

function sortConnections(connections: ModelConnection[]): ModelConnection[] {
  return [...connections].sort((left, right) => {
    if (left.is_default !== right.is_default) {
      return left.is_default ? -1 : 1;
    }
    return left.display_name.localeCompare(right.display_name, "zh-CN");
  });
}
