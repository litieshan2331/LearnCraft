/**
 * 学习画像与目标创建的引导流程组件。
 *
 * 组件：
 * - OnboardingFlow：加载既有画像和模型连接，并协调画像保存、目标创建与成功状态展示。
 * - ProfileForm：收集当前水平、时间、内容偏好、设备和背景。
 * - LearningGoalForm：创建用户自定义主题的学习目标并可选择目标级模型连接。
 * - getGoalIdempotencyKey：在一次目标创建及其安全重试期间复用幂等键。
 */

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, ArrowLeft, CheckCircle2, LoaderCircle, PencilLine } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { z } from "zod";

import {
  createLearningGoal,
  getLearnerProfile,
  type LearnerProfile,
  type LearningGoal,
  ProfileApiError,
  saveLearnerProfile,
} from "../api/profile-client";
import {
  listModelConnections,
  type ModelConnection,
} from "@/modules/model-connection/presentation/api/model-connection-client";
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
import { Select } from "@/shared/ui/primitives/select";
import { Textarea } from "@/shared/ui/primitives/textarea";

const profileFormSchema = z.object({
  current_level: z.enum(["beginner", "intermediate", "advanced"]),
  weekly_minutes: z.number().int().min(30, "每周学习时间至少为 30 分钟。").max(10080, "每周学习时间不能超过 10080 分钟。"),
  operating_system: z.enum(["windows", "macos", "linux", "other"]),
  background_summary: z.string().trim().max(2000, "学习背景不能超过 2000 个字符。"),
  content_preference: z.enum(["document_first", "video_first", "balanced"]),
});

const learningGoalFormSchema = z.object({
  topic: z.string().trim().min(1, "学习主题不能为空。").max(200, "学习主题不能超过 200 个字符。"),
  title: z.string().trim().min(1, "学习目标标题不能为空。").max(200, "学习目标标题不能超过 200 个字符。"),
  description: z.string().trim().min(1, "请说明你想学习什么。").max(4000, "学习说明不能超过 4000 个字符。"),
  desired_outcome: z.string().trim().min(1, "请填写期望学习成果。").max(2000, "期望成果不能超过 2000 个字符。"),
  target_date: z.string().refine((value) => !value || isCalendarDate(value), "截止日期不是有效日期。"),
  weekly_minutes_override: z.string().refine((value) => {
    if (!value) {
      return true;
    }
    const minutes = Number(value);
    return Number.isInteger(minutes) && minutes >= 30 && minutes <= 10080;
  }, "每周学习时间必须在 30 到 10080 分钟之间。"),
  model_connection_id: z.string(),
});

type ProfileFormValues = z.infer<typeof profileFormSchema>;
type LearningGoalFormValues = z.infer<typeof learningGoalFormSchema>;
type OnboardingStep = "loading" | "profile" | "goal" | "completed";

const levelOptions: Array<{ value: ProfileFormValues["current_level"]; label: string; description: string }> = [
  { value: "beginner", label: "刚开始", description: "还不熟悉常见编程概念和代码阅读。" },
  { value: "intermediate", label: "有一些基础", description: "能读懂简单代码，希望系统补齐一门技术。" },
  { value: "advanced", label: "已有经验", description: "有开发经验，希望快速定位特定主题的薄弱点。" },
];

const preferenceOptions: Array<{ value: ProfileFormValues["content_preference"]; label: string; description: string }> = [
  { value: "document_first", label: "文档优先", description: "先读清概念和代码说明。" },
  { value: "video_first", label: "视频优先", description: "先通过讲解建立直觉。" },
  { value: "balanced", label: "均衡安排", description: "按知识点组合文档与视频。" },
];

export function OnboardingFlow() {
  const [step, setStep] = useState<OnboardingStep>("loading");
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [modelConnections, setModelConnections] = useState<ModelConnection[]>([]);
  const [createdGoal, setCreatedGoal] = useState<LearningGoal | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const goalIdempotencyKeyRef = useRef<string | null>(null);

  const profileForm = useForm<ProfileFormValues>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: {
      current_level: "beginner",
      weekly_minutes: 300,
      operating_system: "windows",
      background_summary: "",
      content_preference: "balanced",
    },
  });
  const goalForm = useForm<LearningGoalFormValues>({
    resolver: zodResolver(learningGoalFormSchema),
    defaultValues: {
      topic: "",
      title: "",
      description: "",
      desired_outcome: "",
      target_date: "",
      weekly_minutes_override: "",
      model_connection_id: "",
    },
  });

  useEffect(() => {
    let active = true;

    void Promise.all([getLearnerProfile(), listModelConnections()])
      .then(([loadedProfile, loadedConnections]) => {
        if (!active) {
          return;
        }

        setProfile(loadedProfile);
        setModelConnections(loadedConnections.filter((connection) => connection.status === "active"));
        if (loadedProfile) {
          profileForm.reset(toProfileFormValues(loadedProfile));
          setStep("goal");
        } else {
          setStep("profile");
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadError(toDisplayError(error));
          setStep("profile");
        }
      });

    return () => {
      active = false;
    };
  }, [profileForm]);

  async function handleProfileSubmit(values: ProfileFormValues): Promise<void> {
    try {
      const savedProfile = await saveLearnerProfile({
        ...values,
        background_summary: values.background_summary || null,
      });
      setProfile(savedProfile);
      profileForm.reset(toProfileFormValues(savedProfile));
      setLoadError(null);
      setStep("goal");
    } catch (error) {
      applyProfileFormApiErrors(error, profileForm, setLoadError);
    }
  }

  async function handleGoalSubmit(values: LearningGoalFormValues): Promise<void> {
    try {
      const goal = await createLearningGoal(
        {
          topic: values.topic,
          title: values.title,
          description: values.description,
          desired_outcome: values.desired_outcome,
          target_date: values.target_date || null,
          weekly_minutes_override: values.weekly_minutes_override
            ? Number(values.weekly_minutes_override)
            : null,
          model_connection_id: values.model_connection_id || null,
        },
        getGoalIdempotencyKey(goalIdempotencyKeyRef),
      );
      setCreatedGoal(goal);
      setLoadError(null);
      setStep("completed");
    } catch (error) {
      applyGoalFormApiErrors(error, goalForm, setLoadError);
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12 sm:px-10 sm:py-16">
      <div className="border border-border border-l-2 border-l-primary bg-card px-6 py-8 sm:px-9 sm:py-10">
        <p className="text-xs tracking-[0.2em] text-primary">LEARNING SETUP / {getStepLabel(step)}</p>
        <h1 className="mt-5 font-heading text-4xl font-normal tracking-tight">从你的真实情况开始</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
          LearnCraft 会用这份画像和目标安排前测与后续学习路线。你可以随时回来更新画像；新建目标会记录当时的画像版本。
        </p>

        {loadError ? (
          <Alert className="mt-7 rounded-none border-[#d9b4a9] bg-[#fff8f5] text-[#8b3f35]" variant="destructive">
            <AlertCircle aria-hidden className="size-4" />
            <AlertDescription className="text-[#8b3f35]">{loadError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="mt-9 border-t border-border pt-8">
          {step === "loading" ? <LoadingState /> : null}
          {step === "profile" ? (
            <ProfileForm form={profileForm} onSubmit={handleProfileSubmit} isUpdating={Boolean(profile)} />
          ) : null}
          {step === "goal" ? (
            <LearningGoalForm
              form={goalForm}
              modelConnections={modelConnections}
              onEditProfile={() => setStep("profile")}
              onSubmit={handleGoalSubmit}
            />
          ) : null}
          {step === "completed" && createdGoal ? (
            <GoalCreatedState
              goal={createdGoal}
              onCreateAnother={() => {
                goalForm.reset();
                goalIdempotencyKeyRef.current = null;
                setCreatedGoal(null);
                setStep("goal");
              }}
            />
          ) : null}
        </div>
      </div>
    </main>
  );
}

function ProfileForm({
  form,
  onSubmit,
  isUpdating,
}: {
  form: UseFormReturn<ProfileFormValues>;
  onSubmit: (values: ProfileFormValues) => Promise<void>;
  isUpdating: boolean;
}) {
  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup className="gap-7">
        <div>
          <p className="text-xs tracking-[0.18em] text-primary">STEP 1 / 学习画像</p>
          <h2 className="mt-3 font-heading text-2xl font-normal">告诉我你的学习方式</h2>
        </div>

        <Field data-invalid={Boolean(form.formState.errors.current_level)}>
          <FieldLabel>整体编程经验</FieldLabel>
          <div className="grid gap-3 sm:grid-cols-3">
            {levelOptions.map((option) => (
              <label className="cursor-pointer border border-border p-4 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5" key={option.value}>
                <input className="sr-only" type="radio" value={option.value} {...form.register("current_level")} />
                <span className="block font-medium">{option.label}</span>
                <span className="mt-2 block text-sm leading-6 text-muted-foreground">{option.description}</span>
              </label>
            ))}
          </div>
          <FieldError errors={[form.formState.errors.current_level]} />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field data-invalid={Boolean(form.formState.errors.weekly_minutes)}>
            <FieldLabel htmlFor="weekly-minutes">每周可投入时间（分钟）</FieldLabel>
            <Input id="weekly-minutes" min={30} max={10080} step={30} type="number" {...form.register("weekly_minutes", { valueAsNumber: true })} />
            <FieldDescription>例如每天约 1 小时可填写 420。</FieldDescription>
            <FieldError errors={[form.formState.errors.weekly_minutes]} />
          </Field>
          <Field data-invalid={Boolean(form.formState.errors.operating_system)}>
            <FieldLabel htmlFor="operating-system">主要设备</FieldLabel>
            <Select id="operating-system" {...form.register("operating_system")}>
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
              <option value="linux">Linux</option>
              <option value="other">其他</option>
            </Select>
            <FieldDescription>后续 Demo 与操作提示会优先适配此设备。</FieldDescription>
            <FieldError errors={[form.formState.errors.operating_system]} />
          </Field>
        </div>

        <Field data-invalid={Boolean(form.formState.errors.content_preference)}>
          <FieldLabel>内容偏好</FieldLabel>
          <div className="grid gap-3 sm:grid-cols-3">
            {preferenceOptions.map((option) => (
              <label className="cursor-pointer border border-border p-4 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5" key={option.value}>
                <input className="sr-only" type="radio" value={option.value} {...form.register("content_preference")} />
                <span className="block font-medium">{option.label}</span>
                <span className="mt-2 block text-sm leading-6 text-muted-foreground">{option.description}</span>
              </label>
            ))}
          </div>
          <FieldError errors={[form.formState.errors.content_preference]} />
        </Field>

        <Field data-invalid={Boolean(form.formState.errors.background_summary)}>
          <FieldLabel htmlFor="background-summary">学习背景（可选）</FieldLabel>
          <Textarea id="background-summary" maxLength={2000} placeholder="例如：会一点 JavaScript，了解变量和函数，但没有系统学习过 Python。" rows={4} {...form.register("background_summary")} />
          <FieldDescription>写下已有经验或顾虑，路线会更贴近你的起点。</FieldDescription>
          <FieldError errors={[form.formState.errors.background_summary]} />
        </Field>

        <div className="flex items-center justify-between border-t border-border pt-6">
          <p className="text-sm text-muted-foreground">{isUpdating ? "保存后，后续新建目标会使用新的画像版本。" : "保存后即可创建第一个 Python 学习目标。"}</p>
          <Button className="h-11 rounded-none px-5" disabled={form.formState.isSubmitting} type="submit">
            {form.formState.isSubmitting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
            {form.formState.isSubmitting ? "正在保存" : "保存并继续"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

function LearningGoalForm({
  form,
  modelConnections,
  onEditProfile,
  onSubmit,
}: {
  form: UseFormReturn<LearningGoalFormValues>;
  modelConnections: ModelConnection[];
  onEditProfile: () => void;
  onSubmit: (values: LearningGoalFormValues) => Promise<void>;
}) {
  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)}>
      <FieldGroup className="gap-7">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <p className="text-xs tracking-[0.18em] text-primary">STEP 2 / 学习目标</p>
            <h2 className="mt-3 font-heading text-2xl font-normal">定义你想完成的事</h2>
          </div>
          <Button className="rounded-none" onClick={onEditProfile} type="button" variant="ghost">
            <PencilLine aria-hidden className="size-4" />
            修改画像
          </Button>
        </div>

        <Field data-invalid={Boolean(form.formState.errors.topic)}>
          <FieldLabel htmlFor="goal-topic">学习主题</FieldLabel>
          <Input id="goal-topic" maxLength={200} placeholder="例如：Vue 3 + TypeScript、Go 并发编程、Kubernetes" {...form.register("topic")} />
          <FieldDescription>支持任意面向程序员的技术主题；请尽量写清技术栈或版本。</FieldDescription>
          <FieldError errors={[form.formState.errors.topic]} />
        </Field>

        <Field data-invalid={Boolean(form.formState.errors.title)}>
          <FieldLabel htmlFor="goal-title">目标名称</FieldLabel>
          <Input id="goal-title" maxLength={200} placeholder="例如：用 6 周完成一个 Vue 3 数据看板" {...form.register("title")} />
          <FieldError errors={[form.formState.errors.title]} />
        </Field>

        <Field data-invalid={Boolean(form.formState.errors.description)}>
          <FieldLabel htmlFor="goal-description">你想学习什么</FieldLabel>
          <Textarea id="goal-description" maxLength={4000} placeholder="说明你现在想解决的问题、感兴趣的方向或希望覆盖的知识范围。" rows={5} {...form.register("description")} />
          <FieldError errors={[form.formState.errors.description]} />
        </Field>

        <Field data-invalid={Boolean(form.formState.errors.desired_outcome)}>
          <FieldLabel htmlFor="desired-outcome">期望成果</FieldLabel>
          <Textarea id="desired-outcome" maxLength={2000} placeholder="例如：能独立处理 CSV 数据、写出函数，并完成一个可运行的小项目。" rows={4} {...form.register("desired_outcome")} />
          <FieldError errors={[form.formState.errors.desired_outcome]} />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field data-invalid={Boolean(form.formState.errors.target_date)}>
            <FieldLabel htmlFor="target-date">期望完成日期（可选）</FieldLabel>
            <Input id="target-date" type="date" {...form.register("target_date")} />
            <FieldError errors={[form.formState.errors.target_date]} />
          </Field>
          <Field data-invalid={Boolean(form.formState.errors.weekly_minutes_override)}>
            <FieldLabel htmlFor="weekly-override">本目标每周时间（可选）</FieldLabel>
            <Input id="weekly-override" min={30} max={10080} placeholder="默认使用画像中的时间" step={30} type="number" {...form.register("weekly_minutes_override")} />
            <FieldError errors={[form.formState.errors.weekly_minutes_override]} />
          </Field>
        </div>

        <Field data-invalid={Boolean(form.formState.errors.model_connection_id)}>
          <FieldLabel htmlFor="goal-model-connection">生成模型（可选）</FieldLabel>
          <Select id="goal-model-connection" {...form.register("model_connection_id")}>
            <option value="">使用账户默认模型连接</option>
            {modelConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.display_name} · {connection.default_model_id}{connection.is_default ? "（账户默认）" : ""}
              </option>
            ))}
          </Select>
          {modelConnections.length === 0 ? (
            <FieldDescription>
              你还没有可用模型连接。目标仍可先保存；开始生成前测前请前往 <Link className="text-primary underline underline-offset-4" href="/settings/models">模型连接</Link> 完成配置。
            </FieldDescription>
          ) : (
            <FieldDescription>不选择时，后续生成会使用账户默认连接。</FieldDescription>
          )}
          <FieldError errors={[form.formState.errors.model_connection_id]} />
        </Field>

        <div className="flex flex-col-reverse justify-between gap-4 border-t border-border pt-6 sm:flex-row sm:items-center">
          <Button className="w-fit rounded-none px-0 text-muted-foreground" onClick={onEditProfile} type="button" variant="ghost">
            <ArrowLeft aria-hidden className="size-4" />
            返回修改画像
          </Button>
          <Button className="h-11 rounded-none px-5" disabled={form.formState.isSubmitting} type="submit">
            {form.formState.isSubmitting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
            {form.formState.isSubmitting ? "正在创建" : "创建学习目标"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

function GoalCreatedState({ goal, onCreateAnother }: { goal: LearningGoal; onCreateAnother: () => void }) {
  return (
    <div className="py-5">
      <CheckCircle2 aria-hidden className="size-7 text-primary" />
      <p className="mt-5 text-xs tracking-[0.18em] text-primary">GOAL CREATED</p>
      <h2 className="mt-3 font-heading text-3xl font-normal">{goal.title}</h2>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
        学习目标已保存，并绑定画像版本 {goal.profile_version}。下一步生成前测，用真实答题结果确定路线的切入点。
      </p>
      <div className="mt-8 border-y border-border py-4 text-sm">
        <span className="text-muted-foreground">当前状态</span>
        <span className="ml-4 font-medium">等待前测</span>
      </div>
      <div className='mt-7 flex flex-wrap gap-3'>
        <Button asChild className='rounded-none'>
          <Link href={'/goals/' + goal.id + '/assessment'}>开始前测</Link>
        </Button>
        <Button className='rounded-none' onClick={onCreateAnother} type='button' variant='outline'>
          创建另一个目标
        </Button>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-60 flex-col items-center justify-center text-center">
      <LoaderCircle aria-hidden className="size-5 animate-spin text-primary" />
      <p className="mt-4 text-sm text-muted-foreground">正在读取你的学习设置…</p>
    </div>
  );
}

function toProfileFormValues(profile: LearnerProfile): ProfileFormValues {
  return {
    current_level: profile.current_level,
    weekly_minutes: profile.weekly_minutes,
    operating_system: profile.operating_system ?? "windows",
    background_summary: profile.background_summary ?? "",
    content_preference: profile.content_preference,
  };
}

function applyProfileFormApiErrors(
  error: unknown,
  form: UseFormReturn<ProfileFormValues>,
  setErrorMessage: (message: string | null) => void,
): void {
  if (error instanceof ProfileApiError) {
    for (const fieldError of error.fieldErrors) {
      if (fieldError.field === "current_level" || fieldError.field === "weekly_minutes" || fieldError.field === "operating_system" || fieldError.field === "background_summary" || fieldError.field === "content_preference") {
        form.setError(fieldError.field, { message: fieldError.message });
      }
    }
    setErrorMessage(error.message);
    return;
  }

  setErrorMessage("网络连接异常，请确认服务已启动后重试。");
}

function applyGoalFormApiErrors(
  error: unknown,
  form: UseFormReturn<LearningGoalFormValues>,
  setErrorMessage: (message: string | null) => void,
): void {
  if (error instanceof ProfileApiError) {
    for (const fieldError of error.fieldErrors) {
      if (fieldError.field === "topic" || fieldError.field === "title" || fieldError.field === "description" || fieldError.field === "desired_outcome" || fieldError.field === "target_date" || fieldError.field === "weekly_minutes_override" || fieldError.field === "model_connection_id") {
        form.setError(fieldError.field, { message: fieldError.message });
      }
    }
    setErrorMessage(error.message);
    return;
  }

  setErrorMessage("网络连接异常，请确认服务已启动后重试。");
}

function toDisplayError(error: unknown): string {
  return error instanceof Error ? error.message : "请求暂时无法完成，请稍后重试。";
}

function getStepLabel(step: OnboardingStep): string {
  switch (step) {
    case "profile":
      return "STEP 1 / 2";
    case "goal":
      return "STEP 2 / 2";
    case "completed":
      return "READY FOR ASSESSMENT";
    default:
      return "PREPARING";
  }
}

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function getGoalIdempotencyKey(reference: { current: string | null }): string {
  if (!reference.current) {
    reference.current = crypto.randomUUID();
  }
  return reference.current;
}
