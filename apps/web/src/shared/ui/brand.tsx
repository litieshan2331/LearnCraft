/**
 * LearnCraft 跨页面复用的品牌标识组件。
 *
 * 组件：
 * - Brand：渲染可跳转首页的 LearnCraft 品牌文字与图形标识。
 */

import Link from "next/link";

interface BrandProps {
  inverse?: boolean;
}

export function Brand({ inverse = false }: BrandProps) {
  const textColor = inverse ? "text-white" : "text-slate-950";

  return (
    <Link aria-label="前往 LearnCraft 首页" className="inline-flex items-center gap-2.5" href="/">
      <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-cyan-300 text-sm font-black text-slate-950 shadow-sm shadow-cyan-300/30">
        L
      </span>
      <span className={`text-lg font-bold tracking-tight ${textColor}`}>LearnCraft</span>
    </Link>
  );
}
