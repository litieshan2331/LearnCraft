/**
 * 学习者画像的受保护入口页。
 *
 * 组件：
 * - OnboardingPage：在 Profile API 与表单完成前，明确展示认证完成后的下一步入口。
 */

export default function OnboardingPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 sm:px-10">
      <p className="text-sm font-semibold text-cyan-700">STEP 1 OF 4</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">先告诉 LearnCraft 你的学习情况</h1>
      <p className="mt-4 max-w-2xl leading-7 text-slate-600">
        认证与登录页面已完成。下一步会在这里接入学习者画像表单：当前水平、每周可用时间、操作系统和内容偏好。
      </p>
      <div className="mt-10 rounded-2xl border border-dashed border-cyan-300 bg-cyan-50 p-6">
        <p className="font-semibold text-slate-900">等待接入 Profile API</p>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          画像保存接口与表单将在下一步实现；完成后才可以创建学习目标和开始前测。
        </p>
      </div>
    </main>
  );
}
