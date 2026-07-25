/**
 * Identity 登录表单组件。
 *
 * 组件：
 * - LoginForm：校验邮箱与密码，调用登录接口，成功后跳转到受保护的画像入口。
 */

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { login, AuthenticationApiError, type LoginRequest } from "../api/auth-client";
import { loginRequestSchema } from "../../interfaces/auth-schemas";

export function LoginForm() {
  const router = useRouter();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: LoginRequest): Promise<void> {
    setSubmitError(null);

    try {
      await login(values);
      router.replace("/onboarding");
      router.refresh();
    } catch (error) {
      applyAuthenticationError(error, form.setError, setSubmitError);
    }
  }

  return (
    <form className="space-y-5" noValidate onSubmit={form.handleSubmit(onSubmit)}>
      <FormError message={submitError} />
      <label className="block">
        <span className="text-sm font-medium text-slate-800">邮箱</span>
        <input
          autoComplete="email"
          className={inputClassName}
          placeholder="you@example.com"
          type="email"
          {...form.register("email")}
        />
        <FieldError message={form.formState.errors.email?.message} />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-800">密码</span>
        <input
          autoComplete="current-password"
          className={inputClassName}
          placeholder="输入你的密码"
          type="password"
          {...form.register("password")}
        />
        <FieldError message={form.formState.errors.password?.message} />
      </label>
      <button
        className="flex min-h-12 w-full items-center justify-center rounded-xl bg-slate-950 px-5 font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={form.formState.isSubmitting}
        type="submit"
      >
        {form.formState.isSubmitting ? "正在登录…" : "登录并继续学习"}
      </button>
    </form>
  );
}

const inputClassName = "mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3.5 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100";

function FieldError({ message }: { message: string | undefined }) {
  return message ? <span className="mt-1.5 block text-sm text-rose-700">{message}</span> : null;
}

function FormError({ message }: { message: string | null }) {
  return message ? <p aria-live="polite" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800">{message}</p> : null;
}

function applyAuthenticationError(
  error: unknown,
  setFieldError: ReturnType<typeof useForm<LoginRequest>>["setError"],
  setSubmitError: (message: string | null) => void,
): void {
  if (error instanceof AuthenticationApiError) {
    for (const fieldError of error.fieldErrors) {
      if (fieldError.field === "email" || fieldError.field === "password") {
        setFieldError(fieldError.field, { message: fieldError.message });
      }
    }
    setSubmitError(error.message);
    return;
  }

  setSubmitError("网络连接异常，请确认服务已启动后重试。");
}
