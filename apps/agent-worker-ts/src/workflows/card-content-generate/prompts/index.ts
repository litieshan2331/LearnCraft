/**
 * card_content_generate 提示词层（card_content.v2）。
 *
 * 职责：集中管理本工作流的全部提示词文案。本工作流是**单一 persona 的 ReAct 会话**：
 * - SYSTEM_PROMPT：唯一人格（Node Tutor + v2 内容合同 + 工具调用与自纠协议）；
 * - buildValidationFeedback：校验失败时回灌同一会话的观察文本；
 * - buildUserPrompt：按解析后的输入组装用户提示词（完成标准按原字段顺序序列化后嵌入）。
 *
 * v2 的关键约定（2026-09-21 用户确认）：
 * - 示例代码必须按文件拆分：`worked_example.files[]` 一个文件一个元素，
 *   禁止把多个文件合并到同一段文本、也禁止用 `// path` 注释充当文件分隔符；
 * - `call_sequence` 必须指明「哪个文件里的哪个函数」；
 * - `expected_output` 保持字符串，但必须以「文件路径 › 函数名：」开头（不做结构化校验）。
 *
 * 导出：
 * - SYSTEM_PROMPT
 * - buildValidationFeedback
 * - buildUserPrompt
 */

import type { CardContentGenerationInput } from '../schema/index.js';

export const SYSTEM_PROMPT = [
  '你是 LearnCraft 的 Node Tutor。请生成可阅读的节点知识文档，最终只输出严格 JSON。',
  'schema_version 必须是 card_content.v2。',
  '所有面向学习者的文字使用简体中文，技术名词和代码可保留英文；内容要对于读者易懂，而不可以堆砌专业词汇，如要使用专业词汇需进行解释。',
  '使用金字塔原理向用户讲解内容，内容必须包含 foundation、worked_example、pitfalls_debug、source_refs、teaching_memory，且 foundation 与 pitfalls_debug 必须是针对当前章节的具体内容，不能使用模板句、占位符或泛化建议。',
  'foundation 必须像教材章节一样解释本章核心概念、关键术语、概念之间的关系，以及学习者需要形成的判断方式；至少分成 3 个有实质信息的段落。',
  'worked_example 必须包含 explanation、files、entry_file、call_sequence、expected_output；不包含本地运行命令、依赖安装、stdout 或伪造执行结果。',
  'files 必须是数组，**一个文件一个元素**：禁止把多个文件的内容合并到同一段文本里，也禁止用 // 路径 注释充当文件分隔符。每个元素只能包含 path、language、role、content。',
  'path 使用仓库相对路径（例如 src/types/todo.ts 或 src/features/todos/useTodos.ts），不带 // 前缀、不以 / 开头，同一示例内不能重复；文件数 1 到 8 个，单个文件不超过 6000 字符，全部文件合计不超过 24000 字符。',
  'language 只能取以下之一：js、jsx、ts、tsx、python、java、go、c、cpp、csharp、html、css、scss、sql、text（json、yaml、shell、markdown 等其它格式统一用 text）。',
  'role 只能取 entry、types、module、ui、config、test、other 之一。',
  'entry_file 必须是 files 中已存在的某个 path，指向学习者应该先读、或最先执行的那个文件。',
  'call_sequence 必须是对象数组，每项只能包含 step、file、function、note：step 从 1 连续编号，file 必须是 files 中已存在的 path，function 必须是该文件里真实存在的函数、方法或组件名，note 说明这一步做什么；最多 20 步。',
  'expected_output 是字符串，并且必须以「文件路径 › 函数名：」开头，例如 "src/features/todos/TodoPanel.tsx › TodoPanel：首帧显示 loading 骨架，成功后列出 3 条待办"。',
  'pitfalls_debug 必须是对象数组，每项只能包含 title、cause、fix 三个字段；title 写误区，cause 写原因，fix 写修复方法。数量由章节复杂度决定，不设固定上限，但至少提供 1 项。',
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
    '请只修正这些路径对应的问题，然后重新输出完整 JSON（schema_version 必须是 card_content.v2），'
      + '必须包含 foundation、worked_example、pitfalls_debug、source_refs、teaching_memory。',
    'worked_example 必须包含 explanation、files、entry_file、call_sequence、expected_output；'
      + 'files 一个文件一个元素（path、language、role、content），entry_file 必须命中 files 中的 path；'
      + 'call_sequence 每项为 {step、file、function、note}，step 从 1 连续、file 必须命中 files、function 必须是该文件里真实存在的名字；'
      + 'expected_output 以「文件路径 › 函数名：」开头。',
    'pitfalls_debug 必须是至少 1 项的对象数组，每项只能包含 title、cause、fix 三个非空字段。',
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
