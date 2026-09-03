/**
 * Identity 前端会话守卫组件。
 *
 * 组件：
 * - SessionGate：读取当前用户；未登录时跳转登录页，已登录时才渲染学习区域。
 */

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { getCurrentUser } from "../api/auth-client";

export function SessionGate({ children }: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    let isActive = true;

    void getCurrentUser()
      .then(() => {
        if (isActive) {
          setIsChecking(false);
        }
      })
      .catch(() => {
        if (isActive) {
          router.replace("/login");
        }
      });

    return () => {
      isActive = false;
    };
  }, [router]);

  if (isChecking) {
    return (
      <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background px-6 text-center">
        <div aria-hidden className="lc-glow absolute -top-32 right-1/4 size-72 rounded-full bg-primary/[0.1] blur-3xl" />
        <div className="relative rounded-[1.25rem] border border-border/80 bg-card/80 px-8 py-7 shadow-[0_24px_70px_-46px_rgba(23,53,58,0.5)]">
          <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-primary/10 text-primary"><span className="size-2.5 rounded-full bg-primary" /></div>
          <p className="mt-4 text-sm text-muted-foreground">正在确认登录状态…</p>
        </div>
      </main>
    );
  }

  return children;
}
