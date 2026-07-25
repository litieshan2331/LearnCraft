/**
 * 登录后学习区域的共用布局。
 *
 * 组件：
 * - LearnLayout：使用 SessionGate 保护学习路由，并显示最小导航骨架。
 */

import Link from "next/link";

import { LogoutButton } from "@/modules/identity/presentation/components/logout-button";
import { SessionGate } from "@/modules/identity/presentation/components/session-gate";
import { Brand } from "@/shared/ui/brand";

export default function LearnLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <SessionGate>
      <div className="min-h-screen bg-slate-100 text-slate-950">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6 sm:px-10">
            <Brand />
            <nav className="flex items-center gap-5 text-sm font-medium">
              <Link className="text-slate-600 transition hover:text-slate-950" href="/onboarding">
                学习起点
              </Link>
              <LogoutButton />
            </nav>
          </div>
        </header>
        {children}
      </div>
    </SessionGate>
  );
}
