/**
 * 工具上下文 token 测量的纯函数测试：覆盖 UTF-8 字节计算、重复回灌累计值和非法参数。
 */

import { describe, expect, it } from 'vitest';
import { measureToolResultContext } from '../src/application/services/tool-context-token-measurement.js';

describe('measureToolResultContext', () => {
  it('按 UTF-8 字节估算单条结果，并计算多轮累计节省', () => {
    const result = measureToolResultContext({
      rawResult: '原始网页内容'.repeat(100),
      compactResult: JSON.stringify({ ok: true, code: 'OK', message: '完成', data: { sources: [] } }),
      requestsAfterTool: 3,
      bytesPerToken: 4,
    });

    expect(result.raw.bytes).toBeGreaterThan(result.compact.bytes);
    expect(result.raw.cumulativeEstimatedTokens).toBe(result.raw.estimatedTokens * 3);
    expect(result.compact.cumulativeEstimatedTokens).toBe(result.compact.estimatedTokens * 3);
    expect(result.saved.cumulativeEstimatedTokens).toBe(
      result.raw.cumulativeEstimatedTokens - result.compact.cumulativeEstimatedTokens,
    );
    expect(result.saved.reductionPercent).toBeGreaterThan(0);
  });

  it('拒绝无效的回灌轮数和 token 比例', () => {
    expect(() => measureToolResultContext({ rawResult: 'x', compactResult: 'y', requestsAfterTool: 0 })).toThrow();
    expect(() => measureToolResultContext({ rawResult: 'x', compactResult: 'y', requestsAfterTool: 1, bytesPerToken: 0 })).toThrow();
  });
});
