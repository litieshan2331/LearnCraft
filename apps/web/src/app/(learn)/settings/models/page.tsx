/**
 * 登录后模型连接设置页面。
 *
 * 组件：
 * - ModelConnectionsPage：承载用户自带模型连接的说明与交互容器。
 */

import { ModelConnectionsSettings } from "@/modules/model-connection/presentation/components/model-connections-settings";

export default function ModelConnectionsPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-12 sm:px-10 sm:py-16">
      <p className="text-xs tracking-[0.2em] text-primary">SETTINGS / MODELS</p>
      <h1 className="mt-5 font-heading text-4xl font-normal tracking-tight sm:text-5xl">模型连接</h1>
      <p className="mt-5 max-w-2xl leading-8 text-muted-foreground">
        使用你信任的模型 Provider。LearnCraft 负责学习流程、检索和生成任务的运行边界；你始终可以看到并选择使用的连接与模型。
      </p>
      <ModelConnectionsSettings />
    </main>
  );
}
