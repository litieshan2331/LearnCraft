/**
 * LearnCraft 公共首页。
 *
 * 组件：
 * - Home：展示产品定位，并提供注册与登录入口。
 */

import Link from "next/link";

import { Brand } from "@/shared/ui/brand";

const learningStages = ["概念", "语法", "实战", "调试"];

export default function Home() {
  return (
    <main className="min-h-screen bg-background px-6 text-foreground sm:px-10">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col">
        <header className="flex min-h-20 items-center justify-between gap-4 border-b border-border">
          <Brand />
          <div className="flex items-center gap-2 text-sm">
            <Link className="px-3 py-2 text-muted-foreground transition-colors hover:text-foreground" href="/login">
              登录
            </Link>
            <Link className="border border-foreground px-4 py-2 font-medium transition-colors hover:bg-foreground hover:text-background" href="/register">
              开始学习
            </Link>
          </div>
        </header>

        <section className="grid flex-1 content-center gap-12 py-20 lg:grid-cols-12 lg:py-28">
          <div className="lg:col-span-8">
            <p className="mb-6 text-xs tracking-[0.2em] text-primary">LEARNCRAFT / PROGRAMMER LEARNING</p>
            <h1 className="max-w-4xl font-heading text-5xl font-normal leading-[1.25] tracking-tight sm:text-7xl">
            把零散学习，
              <span className="text-primary">变成能实践的路线。</span>
            </h1>
            <p className="mt-8 max-w-2xl text-base leading-8 text-muted-foreground sm:text-lg">
            LearnCraft 面向程序员，从你的基础、目标和时间出发，逐步组织内容、Demo、练习与测验，帮助你完成从规划到实践的闭环。
            </p>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              <Link className="inline-flex min-h-12 items-center justify-center bg-primary px-6 font-medium text-primary-foreground transition-colors hover:bg-[#3e5243]" href="/register">
              创建学习账号
              </Link>
              <Link className="inline-flex min-h-12 items-center justify-center border border-border px-6 font-medium transition-colors hover:border-foreground" href="/login">
              我已有账号
              </Link>
            </div>
          </div>
          <aside className="border-l border-border pl-5 lg:col-span-3 lg:col-start-10 lg:self-end">
            <p className="text-sm leading-7 text-muted-foreground">先确定你要去哪里，再由系统把每一步变得清楚、可执行。</p>
          </aside>
        </section>

        <section aria-label="学习闭环" className="grid border-t border-border sm:grid-cols-4">
          {learningStages.map((stage, index) => (
            <div className="border-b border-border py-6 sm:border-r sm:border-b-0 sm:px-5 sm:first:pl-0 sm:last:border-r-0" key={stage}>
              <p className="font-mono text-xs text-primary">0{index + 1}</p>
              <p className="mt-7 text-lg font-medium">{stage}</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {index === 0 && "从关键概念建立正确心智模型。"}
                {index === 1 && "通过小片段掌握可复用的语法。"}
                {index === 2 && "获得带注释与调用顺序的可运行 Demo。"}
                {index === 3 && "在错误与修复中巩固真实能力。"}
              </p>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
