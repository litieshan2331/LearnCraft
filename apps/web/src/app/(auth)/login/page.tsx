/**
 * 登录页面路由。
 *
 * 组件：
 * - LoginPage：组合 Identity 的登录表单与注册导航。
 */

import Link from "next/link";

import { LoginForm } from "@/modules/identity/presentation/components/login-form";

export default function LoginPage() {
  return (
    <div>
      <p className="inline-flex rounded-full bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-[0.14em] text-primary">WELCOME BACK</p>
      <h1 className="mt-5 font-heading text-4xl font-medium tracking-tight">登录 LearnCraft</h1>
      <p className="mt-4 text-sm leading-7 text-muted-foreground">登录后继续完善学习画像，并开始你的第一条学习路线。</p>
      <div className="mt-8 border-t border-border/80 pt-7"><LoginForm /></div>
      <p className="mt-7 text-sm text-muted-foreground">还没有账号？<Link className="ml-1 rounded-sm text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" href="/register">创建账号</Link></p>
    </div>
  );
}
