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
      <p className="text-xs tracking-[0.18em] text-primary">BEGIN HERE</p>
      <h1 className="mt-5 font-heading text-4xl font-normal tracking-tight">创建学习账号</h1>
      <p className="mt-4 text-sm leading-7 text-muted-foreground">注册后请登录，再开始填写你的学习画像。</p>
      <div className="mt-10 border-t border-border pt-8">
        <RegisterForm />
      </div>
      <p className="mt-8 text-sm text-muted-foreground">
        已经有账号？
        <Link className="ml-1 text-primary underline underline-offset-4" href="/login">
          立即登录
        </Link>
      </p>
    </div>
  );
}
