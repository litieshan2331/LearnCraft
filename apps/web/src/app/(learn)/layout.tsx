/**
 * 登录后学习区域的共用工作台布局。
 *
 * 组件：
 * - LearnLayout：使用 SessionGate 保护学习路由，提供稳定的工作台导航、背景氛围和内容容器。
 */

import { Compass, Goal, Settings2 } from "lucide-react";
import Link from "next/link";

import { LogoutButton } from "@/modules/identity/presentation/components/logout-button";
import { SessionGate } from "@/modules/identity/presentation/components/session-gate";
import { Brand } from "@/shared/ui/brand";

const navigationItems = [
  { href: "/onboarding", label: "学习起点", icon: Compass },
  { href: "/goals", label: "我的目标", icon: Goal },
  { href: "/settings/models", label: "模型连接", icon: Settings2 },
];

export default function LearnLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <SessionGate>
      <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="lc-glow absolute -top-52 right-[12%] size-96 rounded-full bg-primary/10 blur-3xl" />
          <div className="lc-float-slow absolute top-1/2 -left-40 size-80 rounded-full bg-chart-2/[0.08] blur-3xl" />
        </div>
        <header className="relative z-10 border-b border-border/80 bg-background/75 backdrop-blur-xl">
          <div className="mx-auto flex min-h-[4.5rem] max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-8 lg:px-10">
            <Brand />
            <div className="flex items-center gap-3 sm:gap-5">
              <nav aria-label="学习工作台导航" className="flex max-w-[min(100%,19rem)] items-center gap-1 overflow-x-auto rounded-full border border-border/80 bg-card/75 p-1 text-sm shadow-sm sm:max-w-none">
                {navigationItems.map(({ href, label, icon: Icon }) => (
                  <Link className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-muted-foreground transition-all hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 sm:px-3.5" href={href} key={href}>
                    <Icon aria-hidden className="size-3.5" />
                    <span>{label}</span>
                  </Link>
                ))}
              </nav>
              <div className="shrink-0 text-sm"><LogoutButton /></div>
            </div>
          </div>
        </header>
        <div className="relative z-0 lc-reveal">{children}</div>
      </div>
    </SessionGate>
  );
}
