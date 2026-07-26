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
      <main className="grid min-h-screen place-items-center bg-background px-6 text-center">
        <p className="text-sm text-muted-foreground">正在确认登录状态…</p>
      </main>
    );
  }

  return children;
}
