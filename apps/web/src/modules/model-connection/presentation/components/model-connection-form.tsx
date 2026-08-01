/**
 * 模型连接的新建与编辑表单。
 *
 * 组件：
 * - ModelConnectionForm：收集名称、Base URL、模型名和仅写 API Key，并在浏览器端进行基础校验。
 */

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
  ModelConnectionApiError,
  type CreateModelConnectionRequest,
  type ModelConnection,
  type UpdateModelConnectionRequest,
} from "../api/model-connection-client";
import { Alert, AlertDescription } from "@/shared/ui/primitives/alert";
import { Button } from "@/shared/ui/primitives/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/shared/ui/primitives/field";
import { Input } from "@/shared/ui/primitives/input";

const formSchema = z.object({
  display_name: z.string().trim().min(1, "请填写便于识别的连接名称。").max(80, "连接名称不能超过 80 个字符。"),
  base_url: z.string().trim().min(1, "请填写 Base URL。").max(2048, "Base URL 不能超过 2048 个字符。"),
  api_key: z.string().trim().max(4096, "API Key 不能超过 4096 个字符。"),
  default_model_id: z.string().trim().min(1, "请填写模型名。").max(255, "模型名不能超过 255 个字符。"),
  set_as_default: z.boolean(),
});

type ModelConnectionFormValues = z.infer<typeof formSchema>;

interface ModelConnectionFormProps {
  connection?: ModelConnection;
  onCancel?: () => void;
  onCreate?: (input: CreateModelConnectionRequest) => Promise<void>;
  onUpdate?: (input: UpdateModelConnectionRequest) => Promise<void>;
}

export function ModelConnectionForm({
  connection,
  onCancel,
  onCreate,
  onUpdate,
}: Readonly<ModelConnectionFormProps>) {
  const isEditing = Boolean(connection);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isApiKeyVisible, setIsApiKeyVisible] = useState(false);
  const form = useForm<ModelConnectionFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      display_name: connection?.display_name ?? "",
      base_url: connection?.base_url ?? "",
      api_key: "",
      default_model_id: connection?.default_model_id ?? "",
      set_as_default: connection?.is_default ?? true,
    },
  });

  async function onSubmit(values: ModelConnectionFormValues): Promise<void> {
    const apiKey = values.api_key.trim();
    if (!isEditing && !apiKey) {
      form.setError("api_key", { message: "新建连接时必须填写 API Key。" });
      return;
    }

    setSubmitError(null);

    try {
      if (isEditing) {
        await onUpdate?.({
          display_name: values.display_name.trim(),
          base_url: values.base_url.trim(),
          default_model_id: values.default_model_id.trim(),
          ...(apiKey ? { api_key: apiKey } : {}),
        });
      } else {
        await onCreate?.({
          display_name: values.display_name.trim(),
          base_url: values.base_url.trim(),
          api_key: apiKey,
          default_model_id: values.default_model_id.trim(),
          set_as_default: values.set_as_default,
        });
      }
    } catch (error) {
      setSubmitError(toFormErrorMessage(error));
    }
  }

  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup className="gap-5">
        {submitError ? (
          <Alert className="rounded-none border-[#d9b4a9] bg-[#fff8f5] text-[#8b3f35]" variant="destructive">
            <AlertDescription className="text-[#8b3f35]">{submitError}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field data-invalid={Boolean(form.formState.errors.display_name)}>
            <FieldLabel htmlFor={`${connection?.id ?? "new"}-connection-name`}>连接名称</FieldLabel>
            <Input
              aria-invalid={Boolean(form.formState.errors.display_name)}
              className="h-11 rounded-none bg-background px-3.5"
              id={`${connection?.id ?? "new"}-connection-name`}
              placeholder="例如：我的 DeepSeek"
              {...form.register("display_name")}
            />
            <FieldError errors={[form.formState.errors.display_name]} />
          </Field>
          <Field data-invalid={Boolean(form.formState.errors.default_model_id)}>
            <FieldLabel htmlFor={`${connection?.id ?? "new"}-model-id`}>默认模型名</FieldLabel>
            <Input
              aria-invalid={Boolean(form.formState.errors.default_model_id)}
              className="h-11 rounded-none bg-background px-3.5 font-mono"
              id={`${connection?.id ?? "new"}-model-id`}
              placeholder="例如：deepseek-v4-pro"
              {...form.register("default_model_id")}
            />
            <FieldError errors={[form.formState.errors.default_model_id]} />
          </Field>
        </div>
        <Field data-invalid={Boolean(form.formState.errors.base_url)}>
          <FieldLabel htmlFor={`${connection?.id ?? "new"}-base-url`}>OpenAI-compatible Base URL</FieldLabel>
          <Input
            aria-invalid={Boolean(form.formState.errors.base_url)}
            className="h-11 rounded-none bg-background px-3.5 font-mono"
            id={`${connection?.id ?? "new"}-base-url`}
            inputMode="url"
            placeholder="https://api.example.com"
            type="url"
            {...form.register("base_url")}
          />
          <FieldDescription>请填写 Provider 提供的 OpenAI-compatible 地址，不含 API Key。</FieldDescription>
          <FieldError errors={[form.formState.errors.base_url]} />
        </Field>
        <Field data-invalid={Boolean(form.formState.errors.api_key)}>
          <FieldLabel htmlFor={`${connection?.id ?? "new"}-api-key`}>
            API Key{isEditing ? "（留空则不替换）" : ""}
          </FieldLabel>
          <div className="relative">
            <Input
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.api_key)}
              className="h-11 rounded-none bg-background px-3.5 pr-11 font-mono"
              id={`${connection?.id ?? "new"}-api-key`}
              placeholder={isEditing ? "保持已保存的 Key 不变" : "粘贴 Provider API Key"}
              type={isApiKeyVisible ? "text" : "password"}
              {...form.register("api_key")}
            />
            <button
              aria-label={isApiKeyVisible ? "隐藏 API Key" : "显示 API Key"}
              className="absolute inset-y-0 right-0 grid w-11 place-items-center text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setIsApiKeyVisible((current) => !current)}
              type="button"
            >
              {isApiKeyVisible ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
            </button>
          </div>
          <FieldDescription>保存后不会再次显示。LearnCraft 只保存加密后的凭据。</FieldDescription>
          <FieldError errors={[form.formState.errors.api_key]} />
        </Field>
        {!isEditing ? (
          <label className="flex cursor-pointer items-start gap-3 border border-border bg-muted/35 p-3.5 text-sm">
            <input
              className="mt-0.5 size-4 accent-primary"
              type="checkbox"
              {...form.register("set_as_default")}
            />
            <span>
              <span className="font-medium">设为账户默认连接</span>
              <span className="mt-1 block leading-6 text-muted-foreground">创建学习目标时可继续为该目标选择其他连接。</span>
            </span>
          </label>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
          <Button className="h-10 rounded-none px-5" disabled={form.formState.isSubmitting} type="submit">
            {form.formState.isSubmitting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
            {form.formState.isSubmitting ? "正在保存…" : isEditing ? "保存修改" : "保存连接"}
          </Button>
          {onCancel ? (
            <Button className="h-10 rounded-none" disabled={form.formState.isSubmitting} onClick={onCancel} type="button" variant="ghost">
              取消
            </Button>
          ) : null}
        </div>
      </FieldGroup>
    </form>
  );
}

function toFormErrorMessage(error: unknown): string {
  if (error instanceof ModelConnectionApiError) {
    return error.message;
  }

  return "网络连接异常，请确认服务已启动后重试。";
}
