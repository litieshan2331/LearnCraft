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
      <p className="inline-flex rounded-full bg-primary/10 px-3 py-1.5 text-xs font-medium tracking-[0.14em] text-primary">BEGIN HERE</p>
      <h1 className="mt-5 font-heading text-4xl font-medium tracking-tight">创建学习账号</h1>
      <p className="mt-4 text-sm leading-7 text-muted-foreground">注册后请登录，再开始填写你的学习画像。</p>
      <div className="mt-8 border-t border-border/80 pt-7"><RegisterForm /></div>
      <p className="mt-7 text-sm text-muted-foreground">已经有账号？<Link className="ml-1 rounded-sm text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" href="/login">立即登录</Link></p>
    </div>
  );
}
