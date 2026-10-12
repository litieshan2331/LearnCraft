/**
 * 学习助手结构化输出失败后的自修复反馈文本。
 * 调用顺序：主 Agent 或子 Agent 捕获校验错误 → buildValidationFeedback → 将反馈追加到同一模型消息链。
 */

/** 将 Zod 或 JSON 错误转成一次性结构修复指令。 */
export function buildValidationFeedback(error: unknown): string {
  return '输出未通过服务端校验：' + (error instanceof Error ? error.message : 'JSON 格式无效')
    + '。只允许修复一次，请返回完整且符合 #输出规则 的 json，不能改用工具绕过校验。';
}
