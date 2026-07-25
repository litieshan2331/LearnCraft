/**
 * 注册页面路由。
 *
 * 组件：
 * - RegisterPage：组合 Identity 的注册表单与登录导航。
 */

import Link from "next/link";

import { RegisterForm } from "@/modules/identity/presentation/components/register-form";

export default function RegisterPage() {
  return (
    <div>
      <p className="text-sm font-semibold text-cyan-700">从现在开始</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">创建学习账号</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">注册后请登录，再开始填写你的学习画像。</p>
      <div className="mt-8">
        <RegisterForm />
      </div>
      <p className="mt-7 text-center text-sm text-slate-600">
        已经有账号？
        <Link className="ml-1 font-semibold text-cyan-700 hover:text-cyan-800" href="/login">
          立即登录
        </Link>
      </p>
    </div>
  );
}
