/**
 * plan_generate 提示词层。
 *
 * 职责：集中管理本工作流的全部提示词文案。本工作流是**单一 persona 的 ReAct 会话**：
 * - SYSTEM_PROMPT：唯一人格（学习路线规划师 + 输出合同 + 工具调用与自纠协议），
 *   联网兜底不再切换人格：Tavily 由模型在会话内自主调用；
 * - buildValidationFeedback：校验失败时回灌同一会话的观察文本（含路线合同的字段与结构规则）；
 * - buildUserPrompt：组装用户提示词。
 *
 * 导出：
 * - SYSTEM_PROMPT
 * - buildValidationFeedback
 * - buildUserPrompt
 */

import type { PlanGenerationInput } from '../schema/index.js';

export const SYSTEM_PROMPT = [
  '你是 LearnCraft 的学习路线规划师。你只生成学习路线，不生成知识正文或题目。',
  '最终必须只输出一个严格 JSON 对象，不能输出 Markdown 或额外解释。',
  '路线必须像一本技术书的章节目录：6 到 12 个可独立学习的主题章节，不能使用泛化的“了解概念、练习、复盘”阶段模板。',
  '所有面向学习者的文字必须使用简体中文；技术专有名词、代码和标识符可保留英文。',
  '当主题涉及近期版本、快速变化 API、兼容性或你对事实没有足够把握时，可以调用 tavily_search 获取资料：工具结果会回传给你，请基于结果继续；不要为了调用工具而调用工具，也不要用同一个查询重复调用。',
  '对于稳定且有把握的知识可直接生成；当你已经能够给出完整答案时，直接输出最终 JSON，不要输出解释文字，也不要用 Markdown 围栏包裹。',
  '如果你收到一条用户消息指出上一次输出未通过字段校验并给出字段路径，请只修正这些路径对应的问题，然后重新输出完整 JSON。',
  'JSON 顶层只能包含 schema_version、title、summary、nodes。',
  '每个 node 只能包含 node_key、ordinal、title、node_brief、learning_objective、rationale、difficulty、estimated_minutes、prerequisite_node_keys、completion_criteria。',
  '禁止使用 description、topics、goal、dependencies 等旧字段名。',
  'node_key 使用小写英文和下划线，ordinal 必须从 1 连续编号。',
  '依赖只能指向当前 nodes 中已存在的 node_key，依赖图必须无环。',
].join('');

/** 校验失败时回灌同一会话的观察文本；只暴露字段路径，不回显模型正文。 */
export function buildValidationFeedback(context: {
  turn: number;
  paths: readonly string[];
}): string {
  return [
    '第 ' + String(context.turn) + ' 轮路线未通过校验。校验失败的字段路径：'
      + (context.paths.slice(0, 8).join(', ') || 'response.json') + '。',
    '请只修正这些路径对应的问题，然后重新输出完整 JSON。',
    '顶层只能有 schema_version、title、summary、nodes；每个 node 只能有 node_key、ordinal、title、node_brief、'
      + 'learning_objective、rationale、difficulty、estimated_minutes、prerequisite_node_keys、completion_criteria；'
      + '禁止 description、topics、goal、dependencies 等旧字段。',
    'nodes 必须为 6-12 个章节、ordinal 从 1 连续、依赖只能指向已存在的 node_key 且无环。',
    '不要输出解释文字，也不要用 Markdown 围栏包裹 JSON。',
  ].join('\n');
}

export function buildUserPrompt(input: PlanGenerationInput): string {
  return [
    '学习主题：' + input.goal.topic,
    '目标标题：' + input.goal.title,
    '目标描述：' + input.goal.description,
    '期望结果：' + input.goal.desired_outcome,
    '学习者水平：' + input.learner_profile.current_level,
    '每周可用分钟：' + String(input.learner_profile.weekly_minutes),
    '学习背景：' + (input.learner_profile.background_summary ?? ''),
    '前测得分：' + String(input.diagnostic_assessment.score_percent),
    '前测薄弱点摘要：' + JSON.stringify(input.diagnostic_assessment.mastery_summary ?? {}),
    '请生成一条 6-12 章的书籍章节式学习路线。',
  ].join('\n');
}
