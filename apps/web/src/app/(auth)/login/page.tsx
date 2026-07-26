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
      <p className="text-xs tracking-[0.18em] text-primary">WELCOME BACK</p>
      <h1 className="mt-5 font-heading text-4xl font-normal tracking-tight">登录 LearnCraft</h1>
      <p className="mt-4 text-sm leading-7 text-muted-foreground">登录后继续完善学习画像，并开始你的第一条学习路线。</p>
      <div className="mt-10 border-t border-border pt-8">
        <LoginForm />
      </div>
      <p className="mt-8 text-sm text-muted-foreground">
        还没有账号？
        <Link className="ml-1 text-primary underline underline-offset-4" href="/register">
          创建账号
        </Link>
      </p>
    </div>
  );
}
