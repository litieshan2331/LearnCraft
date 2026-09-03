/**
 * Identity 注册表单组件。
 *
 * 组件：
 * - RegisterForm：校验昵称、邮箱和密码，创建账号后跳转到登录页；注册不会自动登录。
 */

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { register, AuthenticationApiError, type RegisterRequest } from "../api/auth-client";
import { registerRequestSchema } from "../../interfaces/auth-schemas";
import { Alert, AlertDescription } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/shared/ui/primitives/field";
import { Input } from "@/shared/ui/primitives/input";

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
    <form noValidate onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup className="gap-5">
        {submitError ? (
          <Alert className="rounded-xl border-destructive/25 bg-destructive/5 text-destructive" variant="destructive">
            <AlertCircle aria-hidden className="size-4" />
            <AlertDescription className="text-destructive">{submitError}</AlertDescription>
          </Alert>
        ) : null}
        <Field data-invalid={Boolean(form.formState.errors.display_name)}>
          <FieldLabel htmlFor="register-display-name">昵称</FieldLabel>
          <Input
          autoComplete="nickname"
          aria-invalid={Boolean(form.formState.errors.display_name)}
          className="h-12 rounded-xl bg-background/70 px-3.5"
          id="register-display-name"
          placeholder="例如：小林"
          type="text"
          {...form.register("display_name")}
          />
          <FieldError errors={[form.formState.errors.display_name]} />
        </Field>
        <Field data-invalid={Boolean(form.formState.errors.email)}>
          <FieldLabel htmlFor="register-email">邮箱</FieldLabel>
          <Input
          autoComplete="email"
          aria-invalid={Boolean(form.formState.errors.email)}
          className="h-12 rounded-xl bg-background/70 px-3.5"
          id="register-email"
          placeholder="you@example.com"
          type="email"
          {...form.register("email")}
          />
          <FieldError errors={[form.formState.errors.email]} />
        </Field>
        <Field data-invalid={Boolean(form.formState.errors.password)}>
          <FieldLabel htmlFor="register-password">密码</FieldLabel>
          <Input
          autoComplete="new-password"
          aria-invalid={Boolean(form.formState.errors.password)}
          className="h-12 rounded-xl bg-background/70 px-3.5"
          id="register-password"
          placeholder="至少 12 个字符"
          type="password"
          {...form.register("password")}
          />
          <FieldError errors={[form.formState.errors.password]} />
        </Field>
        <Button className="h-12 w-full rounded-xl text-base font-medium" disabled={form.formState.isSubmitting} type="submit">
          {form.formState.isSubmitting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
          {form.formState.isSubmitting ? "正在创建账号…" : "创建账号"}
        </Button>
      </FieldGroup>
    </form>
  );
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
