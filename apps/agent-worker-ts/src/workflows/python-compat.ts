/**
 * 从 Python 迁移过来的宽松规范化所需的语义兼容层。
 *
 * 职责：复刻 Python 中与 JS 语义不同的三处行为，供 plan-recovery.ts 与 card-content-document.ts
 * 共用，避免两份实现出现偏差：
 * - 真值判断：Python 中空字符串、空数组、空对象、0 都是假，JS 中空数组与空对象为真；
 *   模型经常返回 `worked_example: {}` 这类空对象，直接用 `||` 会取错字段。
 * - 短路取值：`a or b or c` 返回第一个真值。
 * - 舍入：Python 的 round 是四舍六入五取偶（2.5 → 2），JS 的 Math.round 是四舍五入（2.5 → 3）。
 *
 * 导出：
 * - pyTruthy / pyOr：Python 真值判断与短路取值。
 * - pythonRound：Python 的 round。
 */

/** 复刻 Python 的真值判断：空字符串、空数组、空对象、0 均为假。 */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) {
    return false;
  }
  if (typeof value === 'string') {
    return value.length > 0;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return true;
}

/** 复刻 Python 的 `a or b or c`：返回第一个真值，全部为假时返回 undefined。 */
export function pyOr(...values: unknown[]): unknown {
  for (const value of values) {
    if (pyTruthy(value)) {
      return value;
    }
  }
  return undefined;
}

/** 复刻 Python 的 round：四舍六入五取偶。 */
export function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) {
    return floor + 1;
  }
  if (fraction < 0.5) {
    return floor;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}
