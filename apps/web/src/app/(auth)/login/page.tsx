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
      <p className="text-sm font-semibold text-cyan-700">欢迎回来</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">登录 LearnCraft</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">登录后继续完善学习画像，并开始你的第一条学习路线。</p>
      <div className="mt-8">
        <LoginForm />
      </div>
      <p className="mt-7 text-center text-sm text-slate-600">
        还没有账号？
        <Link className="ml-1 font-semibold text-cyan-700 hover:text-cyan-800" href="/register">
          创建账号
        </Link>
      </p>
    </div>
  );
}
