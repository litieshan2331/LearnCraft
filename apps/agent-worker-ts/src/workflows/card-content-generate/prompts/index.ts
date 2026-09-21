/**
 * card_content_generate 提示词层。
 *
 * 职责：集中管理本工作流的全部提示词文案。本工作流是**单一 persona 的 ReAct 会话**：
 * - SYSTEM_PROMPT：唯一人格（Node Tutor + 内容合同 + 工具调用与自纠协议）；
 *   联网兜底不再切换人格：Tavily 由模型在会话内自主调用；
 * - buildValidationFeedback：校验失败时回灌同一会话的观察文本；
 * - buildUserPrompt：按解析后的输入组装用户提示词（完成标准按原字段顺序序列化后嵌入）。
 *
 * 导出：
 * - SYSTEM_PROMPT
 * - buildValidationFeedback
 * - buildUserPrompt
 */

import type { CardContentGenerationInput } from '../schema/index.js';

export const SYSTEM_PROMPT = [
  '你是 LearnCraft 的 Node Tutor。请生成可阅读的节点知识文档，最终只输出严格 JSON。',
  '所有面向学习者的文字使用简体中文，技术名词和代码可保留英文；内容要对于读者易懂，而不可以堆砌专业词汇，如要使用专业词汇需进行解释。',
  '使用金字塔原理向用户讲解内容，内容必须包含 foundation、worked_example、pitfalls_debug、source_refs、teaching_memory，且 foundation 与 pitfalls_debug 必须是针对当前章节的具体内容，不能使用模板句、占位符或泛化建议。',
  'foundation 必须像教材章节一样解释本章核心概念、关键术语、概念之间的关系，以及学习者需要形成的判断方式；至少分成 3 个有实质信息的段落。',
  'pitfalls_debug 必须是对象数组，每项只能包含 title、cause、fix 三个字段；title 写误区，cause 写原因，fix 写修复方法。数量由章节复杂度决定，不设固定上限，但至少提供 1 项。',
  'worked_example 必须包含 explanation、code、call_sequence、expected_output；不包含本地运行命令、依赖安装、stdout 或伪造执行结果。',
  'teaching_memory 必须包含 key_concepts、common_mistakes、assessment_targets。',
  '当涉及近期 API、版本或你不确定的事实时，可以调用 tavily_search 获取资料：工具结果会回传给你，请基于结果继续；不要为了调用工具而调用工具，也不要用同一个查询重复调用。',
  '当你已经能够给出完整答案时，直接输出最终 JSON：不要输出解释文字，也不要用 Markdown 围栏包裹。',
  '如果你收到一条用户消息指出上一次输出未通过字段校验并给出字段路径，请只修正这些路径对应的问题，然后重新输出完整 JSON。',
].join('');

/** 校验失败时回灌同一会话的观察文本；只暴露字段路径，不回显模型正文。 */
export function buildValidationFeedback(context: {
  turn: number;
  paths: readonly string[];
}): string {
  return [
    '第 ' + String(context.turn) + ' 轮节点内容未通过校验。校验失败的字段路径：'
      + (context.paths.slice(0, 8).join(', ') || 'response.json') + '。',
    '请只修正这些路径对应的问题，然后重新输出完整 JSON，必须包含 foundation、worked_example、pitfalls_debug、source_refs、teaching_memory。',
    'pitfalls_debug 必须是至少 1 项的对象数组，每项只能包含 title、cause、fix 三个非空字段，数量不设固定上限；'
      + 'worked_example 必须有 explanation、code、call_sequence、expected_output。',
    '不要输出解释文字，也不要用 Markdown 围栏包裹 JSON。',
  ].join('\n');
}

export function buildUserPrompt(value: CardContentGenerationInput): string {
  const node = value.plan_node;
  const goal = value.goal;
  const profile = value.learner_profile;
  return [
    '学习主题：' + String(goal.topic ?? ''),
    '学习目标：' + String(goal.desired_outcome ?? ''),
    '学习者水平：' + String(profile.current_level ?? ''),
    '章节标题：' + String(node.title ?? ''),
    '章节摘要：' + String(node.node_brief ?? ''),
    '章节目标：' + String(node.learning_objective ?? ''),
    '完成标准：' + JSON.stringify(node.completion_criteria ?? []),
  ].join('\n');
}
