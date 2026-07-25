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
    <main className="min-h-screen bg-slate-950 px-6 py-6 text-slate-100 sm:px-10">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-6xl flex-col rounded-[2rem] border border-white/10 bg-[radial-gradient(circle_at_top_right,_rgba(20,184,166,0.24),_transparent_36%),linear-gradient(135deg,_#101827_0%,_#0f172a_55%,_#172554_100%)] px-6 py-6 shadow-2xl shadow-cyan-950/30 sm:px-10 sm:py-8">
        <header className="flex items-center justify-between gap-4">
          <Brand inverse />
          <div className="flex items-center gap-3 text-sm font-medium">
            <Link className="rounded-lg px-3 py-2 text-slate-300 transition hover:bg-white/10 hover:text-white" href="/login">
              登录
            </Link>
            <Link className="rounded-lg bg-cyan-300 px-4 py-2 text-slate-950 transition hover:bg-cyan-200" href="/register">
              开始学习
            </Link>
          </div>
        </header>

        <section className="flex flex-1 flex-col justify-center py-16 sm:py-24">
          <p className="mb-5 text-sm font-semibold tracking-[0.24em] text-cyan-300">LEARNCRAFT · PROGRAMMER LEARNING AGENT</p>
          <h1 className="max-w-4xl text-4xl font-semibold leading-tight tracking-tight text-white sm:text-6xl">
            把零散学习，
            <span className="text-cyan-300">变成能实践的路线。</span>
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-slate-300">
            LearnCraft 面向程序员，从你的基础、目标和时间出发，逐步组织内容、Demo、练习与测验，帮助你完成从规划到实践的闭环。
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link className="inline-flex min-h-12 items-center justify-center rounded-xl bg-cyan-300 px-6 font-semibold text-slate-950 transition hover:bg-cyan-200" href="/register">
              创建学习账号
            </Link>
            <Link className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/20 px-6 font-semibold text-white transition hover:border-white/40 hover:bg-white/10" href="/login">
              我已有账号
            </Link>
          </div>
        </section>

        <section aria-label="学习闭环" className="grid gap-3 sm:grid-cols-4">
          {learningStages.map((stage, index) => (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur" key={stage}>
              <p className="text-xs font-medium text-cyan-200">0{index + 1}</p>
              <p className="mt-6 text-lg font-semibold text-white">{stage}</p>
              <p className="mt-2 text-sm leading-6 text-slate-400">
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
