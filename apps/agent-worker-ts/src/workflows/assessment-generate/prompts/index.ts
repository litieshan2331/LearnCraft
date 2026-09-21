/**
 * assessment_generate 提示词层。
 *
 * 职责：集中管理本工作流的全部提示词文案。本工作流是**单一 persona 的 ReAct 会话**：
 * - SYSTEM_PROMPT：唯一人格（题目设计师 + 输出合同 + 工具调用与自纠协议），整轮会话不再更换；
 * - buildValidationFeedback：校验失败时回灌同一会话的观察文本（由 ReAct 循环以 user 角色追加）；
 * - buildUserPrompt：按解析后的输入组装用户提示词。
 *
 * 导出：
 * - SYSTEM_PROMPT
 * - buildValidationFeedback
 * - buildUserPrompt
 */

import type { AssessmentGenerationInput } from '../schema/index.js';

export const SYSTEM_PROMPT = [
  '你是 LearnCraft 程序员学习评估题目设计师。题目必须是单选题，最终只输出一个严格 JSON 对象，不要输出对象外的 Markdown 或解释文字。',
  '所有面向学习者的自然语言，包括题干、选项、解析与能力标签，必须使用简体中文；技术专有名词可保留英文。',
  '题干或解析需要展示代码时，使用标准 Markdown 三反引号代码围栏；语言标签、代码、命令和标识符保持英文。',
  'JSON 字符串中的结构换行必须使用单层转义 \n，绝不能使用双重转义 \\n；代码中原本需要表示换行字符时保留其自身的转义语义。',
  '你可以在需要时调用 tavily_search 获取或核对资料：工具结果会回传给你，请基于结果继续；不要为了调用工具而调用工具，也不要用同一个查询重复调用。',
  '当你已经能够给出完整答案时，直接输出最终 JSON：不要输出解释文字，也不要用 Markdown 围栏包裹。',
  '如果你收到一条用户消息指出上一次输出未通过字段校验并给出字段路径，请只修正这些路径对应的问题，然后重新输出完整 JSON。',
  'JSON 顶层只能包含 schema_version 和 questions：schema_version 固定为 assessment.single_choice.v1；questions 必须是题目数组。',
  '每道题只能包含 prompt、options、answer_key、explanation、skill_tags、max_score。',
  'options 必须是 2 至 6 个对象，每个对象只能包含 key 和 text；answer_key 必须是 options 中存在的 A 至 F 键；max_score 必须为正数。',
].join('');

/** 校验失败时回灌同一会话的观察文本；只暴露字段路径，不回显模型正文。 */
export function buildValidationFeedback(context: {
  turn: number;
  paths: readonly string[];
}): string {
  return [
    '第 ' + String(context.turn) + ' 轮输出未通过校验。校验失败的字段路径：'
      + (context.paths.slice(0, 8).join(', ') || 'response.json') + '。',
    '请只修正这些路径对应的问题，然后重新输出完整 JSON；题目数量必须与请求严格一致。',
    '顶层只能是 schema_version 和 questions；每题只能包含 prompt、options、answer_key、explanation、skill_tags、max_score，'
      + 'options 必须是 {key,text} 对象数组，answer_key 必须引用已有选项。',
    '不要输出解释文字，也不要用 Markdown 围栏包裹 JSON。',
  ].join('\n');
}

export function buildUserPrompt(input: AssessmentGenerationInput): string {
  return [
    '主题：' + input.topic,
    '标题：' + (input.title ?? input.topic),
    '描述：' + (input.description ?? ''),
    '目标：' + (input.desired_outcome ?? ''),
    '整体编程经验：' + (input.overall_experience ?? ''),
    '测试类型：' + input.kind,
    '难度：' + input.difficulty,
    '请生成恰好 ' + String(input.question_count) + ' 道题，每题包含 prompt、options、answer_key、explanation、skill_tags、max_score。',
  ].join('\n');
}
