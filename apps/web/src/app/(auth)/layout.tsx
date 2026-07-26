/**
 * 认证页面共用布局。
 *
 * 组件：
 * - AuthLayout：为登录与注册页面提供统一品牌区、背景和内容容器。
 */

import Link from "next/link";

import { Brand } from "@/shared/ui/brand";

export default function AuthLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="min-h-screen bg-background px-6 text-foreground sm:px-10">
      <div className="mx-auto grid min-h-screen max-w-6xl lg:grid-cols-[1.1fr_0.9fr]">
        <section className="hidden flex-col justify-between border-r border-border py-10 pr-16 lg:flex">
          <Brand />
        <div>
            <p className="text-xs tracking-[0.2em] text-primary">LEARN WITH INTENTION</p>
            <h1 className="mt-6 max-w-xl font-heading text-5xl font-normal leading-[1.3] tracking-tight">
            让每一次学习，
              <span className="text-primary">都更接近实践。</span>
            </h1>
            <p className="mt-7 max-w-lg text-base leading-8 text-muted-foreground">
            从个人目标出发，逐步获得路线、内容、练习与反馈。
            </p>
        </div>
          <Link className="w-fit text-sm text-muted-foreground transition-colors hover:text-foreground" href="/">
          ← 返回 LearnCraft 首页
        </Link>
        </section>

        <section className="flex min-h-screen flex-col py-7 lg:pl-16 lg:justify-center">
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="mx-auto w-full max-w-md py-16 lg:mx-0 lg:py-0">{children}</div>
        </section>
      </div>
    </main>
  );
}
