/**
 * Web 通用样式工具。
 *
 * 导出：
 * - cn：合并条件 className，并解决 Tailwind 工具类冲突。
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
