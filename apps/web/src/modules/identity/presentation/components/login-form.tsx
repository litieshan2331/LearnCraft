/**
 * Identity 登录表单组件。
 *
 * 组件：
 * - LoginForm：校验邮箱与密码，调用登录接口，成功后跳转到受保护的画像入口。
 */

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { login, AuthenticationApiError, type LoginRequest } from "../api/auth-client";
import { loginRequestSchema } from "../../interfaces/auth-schemas";
import { Alert, AlertDescription } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/shared/ui/primitives/field";
import { Input } from "@/shared/ui/primitives/input";

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
    <form noValidate onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup className="gap-5">
        {submitError ? (
          <Alert className="rounded-none border-[#d9b4a9] bg-[#fff8f5] text-[#8b3f35]" variant="destructive">
            <AlertCircle aria-hidden className="size-4" />
            <AlertDescription className="text-[#8b3f35]">{submitError}</AlertDescription>
          </Alert>
        ) : null}
        <Field data-invalid={Boolean(form.formState.errors.email)}>
          <FieldLabel htmlFor="login-email">邮箱</FieldLabel>
          <Input
          autoComplete="email"
          aria-invalid={Boolean(form.formState.errors.email)}
          className="h-12 rounded-none bg-card px-3.5"
          id="login-email"
          placeholder="you@example.com"
          type="email"
          {...form.register("email")}
          />
          <FieldError errors={[form.formState.errors.email]} />
        </Field>
        <Field data-invalid={Boolean(form.formState.errors.password)}>
          <FieldLabel htmlFor="login-password">密码</FieldLabel>
          <Input
          autoComplete="current-password"
          aria-invalid={Boolean(form.formState.errors.password)}
          className="h-12 rounded-none bg-card px-3.5"
          id="login-password"
          placeholder="输入你的密码"
          type="password"
          {...form.register("password")}
          />
          <FieldError errors={[form.formState.errors.password]} />
        </Field>
        <Button className="h-12 w-full rounded-none text-base font-medium" disabled={form.formState.isSubmitting} type="submit">
          {form.formState.isSubmitting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
          {form.formState.isSubmitting ? "正在登录…" : "登录并继续学习"}
        </Button>
      </FieldGroup>
    </form>
  );
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
