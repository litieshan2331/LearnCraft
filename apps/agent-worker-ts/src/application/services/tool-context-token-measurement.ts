/**
 * 工具上下文 token 测量：比较原始工具结果与 ok/code/message/data 契约在多轮回灌中的估算消耗。
 * 调用顺序：estimateTokenCount 计算单段文本 → measureToolResultContext 计算重复回灌 →
 * formatToolContextMeasurement 生成可读报告；该模块不调用模型或外部工具。
 */

export interface TokenMeasurement {
  bytes: number;
  estimatedTokens: number;
}

export interface ToolContextMeasurement {
  requestsAfterTool: number;
  bytesPerToken: number;
  raw: TokenMeasurement & { cumulativeEstimatedTokens: number };
  compact: TokenMeasurement & { cumulativeEstimatedTokens: number };
  saved: {
    bytes: number;
    estimatedTokens: number;
    cumulativeEstimatedTokens: number;
    reductionPercent: number;
  };
}

/** 按 UTF-8 字节数估算 token；实际账单应优先使用模型网关返回的 inputTokens。 */
export function estimateTokenCount(text: string, bytesPerToken = 4): TokenMeasurement {
  if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0) {
    throw new Error('bytesPerToken 必须是正数。');
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  return { bytes, estimatedTokens: Math.ceil(bytes / bytesPerToken) };
}

/**
 * 计算工具结果在后续模型请求中被重复携带时的累计上下文开销。
 * requestsAfterTool 表示工具返回后还会发出的模型请求数；例如工具发生在第 1 轮、随后还有 3 轮，值为 3。
 */
export function measureToolResultContext(input: {
  rawResult: string;
  compactResult: string;
  requestsAfterTool: number;
  bytesPerToken?: number;
}): ToolContextMeasurement {
  if (!Number.isInteger(input.requestsAfterTool) || input.requestsAfterTool < 1) {
    throw new Error('requestsAfterTool 必须是大于等于 1 的整数。');
  }
  const bytesPerToken = input.bytesPerToken ?? 4;
  const raw = estimateTokenCount(input.rawResult, bytesPerToken);
  const compact = estimateTokenCount(input.compactResult, bytesPerToken);
  const cumulativeRaw = raw.estimatedTokens * input.requestsAfterTool;
  const cumulativeCompact = compact.estimatedTokens * input.requestsAfterTool;
  const savedTokens = raw.estimatedTokens - compact.estimatedTokens;
  const savedBytes = raw.bytes - compact.bytes;
  return {
    requestsAfterTool: input.requestsAfterTool,
    bytesPerToken,
    raw: { ...raw, cumulativeEstimatedTokens: cumulativeRaw },
    compact: { ...compact, cumulativeEstimatedTokens: cumulativeCompact },
    saved: {
      bytes: savedBytes,
      estimatedTokens: savedTokens,
      cumulativeEstimatedTokens: cumulativeRaw - cumulativeCompact,
      reductionPercent: raw.bytes === 0 ? 0 : Number(((savedBytes / raw.bytes) * 100).toFixed(2)),
    },
  };
}

/** 将测量结果转成便于日志和 CI 保存的 JSON 文本。 */
export function formatToolContextMeasurement(measurement: ToolContextMeasurement): string {
  return JSON.stringify(measurement, null, 2);
}
