/**
 * Identity 登出按钮组件。
 *
 * 组件：
 * - LogoutButton：调用登出接口、清理当前浏览器 Session，并跳转到登录页。
 */

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { logout } from "../api/auth-client";

export function LogoutButton() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleLogout(): Promise<void> {
    setIsSubmitting(true);

    try {
      await logout();
    } finally {
      router.replace("/login");
      router.refresh();
      setIsSubmitting(false);
    }
  }

  return (
    <button
      className="rounded-xl px-2.5 py-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50"
      disabled={isSubmitting}
      onClick={handleLogout}
      type="button"
    >
      {isSubmitting ? "正在退出…" : "退出登录"}
    </button>
  );
}
