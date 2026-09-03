/**
 * LearnCraft 跨页面复用的品牌标识组件。
 *
 * 组件：
 * - Brand：渲染可跳转首页的 LearnCraft 品牌文字与图形标识。
 */

import Link from "next/link";

export function Brand() {
  return (
    <Link aria-label="前往 LearnCraft 首页" className="inline-flex items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background" href="/">
      <span aria-hidden className="grid size-7 place-items-center border border-foreground font-mono text-xs font-medium">
        L
      </span>
      <span className="font-heading text-xl font-medium tracking-[0.01em]">LearnCraft</span>
    </Link>
  );
}
