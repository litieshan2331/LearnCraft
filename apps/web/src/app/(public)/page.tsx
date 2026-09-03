/**
 * LearnCraft 公共首页。
 *
 * 组件：
 * - Home：展示产品定位，并提供注册与登录入口。
 */

import { ArrowRight, BookOpen, CheckCircle2 } from "lucide-react";
import Link from "next/link";

import { Brand } from "@/shared/ui/brand";

const learningStages = [
  { number: "01", title: "厘清目标", description: "从你的基础、时间和期待成果开始。" },
  { number: "02", title: "组织路线", description: "把分散知识整理为循序渐进的章节。" },
  { number: "03", title: "动手实践", description: "用 Demo、练习和测验形成真实能力。" },
  { number: "04", title: "持续巩固", description: "从问题与反馈中回看自己的成长。" },
];

export default function Home() {
  return (
    <main className="relative isolate min-h-screen overflow-hidden bg-background px-5 text-foreground sm:px-8 lg:px-10">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="lc-glow absolute -top-36 left-[7%] size-80 rounded-full bg-primary/12 blur-3xl" />
        <div className="lc-float-slow absolute top-1/4 right-[-7rem] size-72 rounded-full bg-chart-4/15 blur-3xl" />
        <div className="lc-float absolute bottom-[-10rem] left-1/3 size-96 rounded-full bg-chart-2/10 blur-3xl" />
      </div>

      <div className="mx-auto flex min-h-screen max-w-7xl flex-col">
        <header className="lc-reveal flex min-h-20 items-center justify-between gap-4 border-b border-border/80">
          <Brand />
          <div className="flex items-center gap-2 text-sm">
            <Link className="rounded-full px-4 py-2.5 text-muted-foreground transition-colors hover:bg-card/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" href="/login">登录</Link>
            <Link className="rounded-full border border-primary/20 bg-card/75 px-4 py-2.5 font-medium text-primary shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" href="/register">开始学习</Link>
          </div>
        </header>

        <section className="grid flex-1 items-center gap-12 py-16 lg:grid-cols-[minmax(0,1fr)_27rem] lg:gap-20 lg:py-24">
          <div>
            <div className="lc-reveal lc-reveal-delay-1 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-card/75 px-3.5 py-2 text-xs font-medium tracking-[0.12em] text-primary shadow-sm">
              <BookOpen aria-hidden className="size-3.5" />
              为真实目标构建学习路径
            </div>
            <h1 className="lc-reveal lc-reveal-delay-2 mt-7 max-w-4xl font-heading text-5xl font-medium leading-[1.12] tracking-[-0.04em] sm:text-6xl lg:text-7xl">
              让每一次学习，
              <span className="block text-primary">都知道下一步去哪里。</span>
            </h1>
            <p className="lc-reveal lc-reveal-delay-3 mt-7 max-w-2xl text-base leading-8 text-muted-foreground sm:text-lg">
              LearnCraft 面向程序员，从你的基础、目标和可投入时间出发，组织内容、Demo、练习与测验，让学习从零散输入变成可以实践的路线。
            </p>
            <div className="lc-reveal lc-reveal-delay-3 mt-9 flex flex-col gap-3 sm:flex-row">
              <Link className="group inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-primary px-6 font-medium text-primary-foreground shadow-[0_12px_30px_-16px_rgba(36,122,128,0.85)] transition-all hover:-translate-y-0.5 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background" href="/register">
                开始构建我的路线
                <ArrowRight aria-hidden className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link className="inline-flex min-h-12 items-center justify-center rounded-full border border-border bg-card/65 px-6 font-medium text-foreground transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:bg-card focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background" href="/login">我已有账号</Link>
            </div>
            <ul className="lc-reveal lc-reveal-delay-3 mt-10 grid max-w-2xl gap-3 text-sm text-muted-foreground sm:grid-cols-3">
              <li className="flex items-center gap-2"><CheckCircle2 aria-hidden className="size-4 text-primary" />从真实起点开始</li>
              <li className="flex items-center gap-2"><CheckCircle2 aria-hidden className="size-4 text-primary" />每一步都有目的</li>
              <li className="flex items-center gap-2"><CheckCircle2 aria-hidden className="size-4 text-primary" />在实践中巩固</li>
            </ul>
          </div>

          <aside aria-label="学习路径示意" className="lc-reveal lc-reveal-delay-2 relative">
            <div aria-hidden className="absolute inset-x-8 -top-5 h-20 rounded-full bg-primary/15 blur-2xl" />
            <div className="relative rounded-[1.5rem] border border-white/80 bg-card/80 p-5 shadow-[0_24px_70px_-34px_rgba(23,53,58,0.48)] backdrop-blur sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-medium tracking-[0.16em] text-primary">LEARNING MAP</p>
                  <h2 className="mt-2 font-heading text-2xl font-medium tracking-tight">一条可执行的路径</h2>
                </div>
                <span className="grid size-10 place-items-center rounded-2xl bg-primary/10 text-primary"><BookOpen aria-hidden className="size-5" /></span>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">不是堆叠课程，而是把目标拆成你今天能开始的一步。</p>
              <ol className="mt-6 space-y-3">
                {learningStages.map((stage, index) => (
                  <li className="group relative flex gap-3" key={stage.number}>
                    {index < learningStages.length - 1 ? <span aria-hidden className="absolute top-10 bottom-[-0.75rem] left-5 border-l border-dashed border-primary/20" /> : null}
                    <span className="relative grid size-10 shrink-0 place-items-center rounded-2xl bg-secondary font-mono text-xs font-medium text-primary transition-transform group-hover:scale-105">{stage.number}</span>
                    <span className="min-w-0 rounded-2xl border border-transparent px-1.5 py-1 transition-colors group-hover:border-primary/10 group-hover:bg-primary/[0.03]">
                      <span className="block font-medium">{stage.title}</span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">{stage.description}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </aside>
        </section>

        <section aria-label="LearnCraft 的学习方式" className="lc-reveal lc-reveal-delay-3 grid gap-3 border-t border-border/80 py-7 sm:grid-cols-3">
          <div className="rounded-2xl border border-border/70 bg-card/55 p-5">
            <p className="text-xs font-medium tracking-[0.14em] text-primary">01 / 清楚</p>
            <p className="mt-3 font-heading text-xl font-medium">知道自己正在学什么</p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-card/55 p-5">
            <p className="text-xs font-medium tracking-[0.14em] text-primary">02 / 从容</p>
            <p className="mt-3 font-heading text-xl font-medium">按自己的节奏继续前进</p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-card/55 p-5">
            <p className="text-xs font-medium tracking-[0.14em] text-primary">03 / 实践</p>
            <p className="mt-3 font-heading text-xl font-medium">把理解变成可用的能力</p>
          </div>
        </section>
      </div>
    </main>
  );
}
