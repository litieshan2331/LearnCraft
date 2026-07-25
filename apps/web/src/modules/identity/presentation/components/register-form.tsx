/**
 * Identity 注册表单组件。
 *
 * 组件：
 * - RegisterForm：校验昵称、邮箱和密码，创建账号后跳转到登录页；注册不会自动登录。
 */

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { register, AuthenticationApiError, type RegisterRequest } from "../api/auth-client";
import { registerRequestSchema } from "../../interfaces/auth-schemas";

export function RegisterForm() {
  const router = useRouter();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm<RegisterRequest>({
    resolver: zodResolver(registerRequestSchema),
    defaultValues: { email: "", display_name: "", password: "" },
  });

  async function onSubmit(values: RegisterRequest): Promise<void> {
    setSubmitError(null);

    try {
      await register(values);
      router.replace("/login");
    } catch (error) {
      applyAuthenticationError(error, form.setError, setSubmitError);
    }
  }

  return (
    <form className="space-y-5" noValidate onSubmit={form.handleSubmit(onSubmit)}>
      <FormError message={submitError} />
      <label className="block">
        <span className="text-sm font-medium text-slate-800">昵称</span>
        <input
          autoComplete="nickname"
          className={inputClassName}
          placeholder="例如：小林"
          type="text"
          {...form.register("display_name")}
        />
        <FieldError message={form.formState.errors.display_name?.message} />
      </label>
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
          autoComplete="new-password"
          className={inputClassName}
          placeholder="至少 12 个字符"
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
        {form.formState.isSubmitting ? "正在创建账号…" : "创建账号"}
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
  setFieldError: ReturnType<typeof useForm<RegisterRequest>>["setError"],
  setSubmitError: (message: string | null) => void,
): void {
  if (error instanceof AuthenticationApiError) {
    for (const fieldError of error.fieldErrors) {
      if (fieldError.field === "display_name" || fieldError.field === "email" || fieldError.field === "password") {
        setFieldError(fieldError.field, { message: fieldError.message });
      }
    }
    setSubmitError(error.message);
    return;
  }

  setSubmitError("网络连接异常，请确认服务已启动后重试。");
}
