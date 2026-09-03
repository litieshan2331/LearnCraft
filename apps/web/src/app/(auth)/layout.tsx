/**
 * 认证页面共用布局。
 *
 * 组件：
 * - AuthLayout：为登录与注册页面提供统一品牌区、舒适背景和聚焦表单容器。
 */

import { ArrowLeft, BookOpen, Sparkles } from "lucide-react";
import Link from "next/link";

import { Brand } from "@/shared/ui/brand";

export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="relative isolate min-h-screen overflow-hidden bg-background px-5 text-foreground sm:px-8 lg:px-10">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="lc-glow absolute -top-36 left-[8%] size-96 rounded-full bg-primary/12 blur-3xl" />
        <div className="lc-float-slow absolute right-[-8rem] bottom-[-10rem] size-96 rounded-full bg-chart-4/15 blur-3xl" />
      </div>
      <div className="mx-auto grid min-h-screen max-w-7xl gap-8 py-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(24rem,0.95fr)] lg:items-stretch lg:py-8">
        <section className="hidden flex-col justify-between rounded-[1.5rem] border border-border/80 bg-card/70 p-8 shadow-[0_28px_80px_-54px_rgba(23,53,58,0.55)] backdrop-blur lg:flex">
          <Brand />
          <div className="py-16">
            <p className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-[0.14em] text-primary"><BookOpen aria-hidden className="size-3.5" />LEARN WITH INTENTION</p>
            <h1 className="mt-7 max-w-xl font-heading text-5xl font-medium leading-[1.18] tracking-tight">
              让每一次学习，
              <span className="block text-primary">都更接近实践。</span>
            </h1>
            <p className="mt-7 max-w-lg text-base leading-8 text-muted-foreground">从个人目标出发，逐步获得路线、内容、练习与反馈。每一步都知道自己正在前往哪里。</p>
          </div>
          <Link className="inline-flex w-fit items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" href="/"><ArrowLeft aria-hidden className="size-4" />返回 LearnCraft 首页</Link>
        </section>

        <section className="flex min-h-[calc(100vh-2.5rem)] flex-col justify-center lg:min-h-0">
          <div className="mb-8 lg:hidden"><Brand /></div>
          <div className="lc-reveal mx-auto w-full max-w-md rounded-[1.5rem] border border-border/80 bg-card/90 p-6 shadow-[0_28px_80px_-50px_rgba(23,53,58,0.55)] backdrop-blur sm:p-8 lg:mx-0 lg:ml-auto">
            <span className="mb-7 grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary"><Sparkles aria-hidden className="size-5" /></span>
            {children}
          </div>
        </section>
      </div>
    </main>
  );
}
