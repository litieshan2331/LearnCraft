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
    <main className="grid min-h-screen bg-slate-100 lg:grid-cols-[1.1fr_0.9fr]">
      <section className="hidden flex-col justify-between bg-slate-950 p-12 text-white lg:flex">
        <Brand inverse />
        <div>
          <p className="text-sm font-semibold tracking-[0.24em] text-cyan-300">LEARN WITH INTENTION</p>
          <h1 className="mt-5 max-w-xl text-5xl font-semibold leading-tight tracking-tight">
            让每一次学习，
            <span className="text-cyan-300">都更接近实践。</span>
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-8 text-slate-300">
            从个人目标出发，逐步获得路线、内容、练习与反馈。
          </p>
        </div>
        <Link className="w-fit text-sm text-slate-400 transition hover:text-white" href="/">
          ← 返回 LearnCraft 首页
        </Link>
      </section>

      <section className="flex min-h-screen flex-col px-6 py-6 sm:px-12 lg:justify-center">
        <div className="lg:hidden">
          <Brand />
        </div>
        <div className="mx-auto w-full max-w-md py-12 lg:py-0">{children}</div>
      </section>
    </main>
  );
}
