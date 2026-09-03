/**
 * 登录后模型连接设置页面。
 *
 * 组件：
 * - ModelConnectionsPage：承载用户自带模型连接的说明与交互容器。
 */

import { Settings2 } from "lucide-react";

import { ModelConnectionsSettings } from "@/modules/model-connection/presentation/components/model-connections-settings";

export default function ModelConnectionsPage() {
  return (
    <main className="relative mx-auto w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-12 lg:px-10">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden"><div className="lc-float absolute -top-8 right-10 size-64 rounded-full bg-primary/[0.08] blur-3xl" /></div>
      <div className="relative">
        <header className="rounded-[1.5rem] border border-border/80 bg-card/80 p-5 shadow-[0_24px_70px_-46px_rgba(23,53,58,0.5)] backdrop-blur sm:p-8">
          <p className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-[0.14em] text-primary"><Settings2 aria-hidden className="size-3.5" />SETTINGS / MODELS</p>
          <h1 className="mt-5 font-heading text-4xl font-medium tracking-tight sm:text-5xl">模型连接</h1>
          <p className="mt-4 max-w-2xl text-sm leading-8 text-muted-foreground">使用你信任的模型 Provider。LearnCraft 负责学习流程、检索和生成任务的运行边界；你始终可以看到并选择使用的连接与模型。</p>
        </header>
        <ModelConnectionsSettings />
      </div>
    </main>
  );
}
