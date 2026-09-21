/**
 * posttest_generate 提示词层。
 *
 * 职责：集中管理本工作流的全部提示词文案。本工作流是**单一 persona 的 ReAct 会话**：
 * - SYSTEM_PROMPT：唯一人格（后测设计师 + 输出合同 + 工具调用与自纠协议）；按 2026-09-18 的产品决策，
 *   联网工具**全程开放**：节点内容与 teaching_memory 仍是主要出题依据，但事实不确定时允许联网核对；
 * - buildValidationFeedback：校验失败时回灌同一会话的观察文本；
 * - serializeCardContentContext：按契约字段顺序序列化固定节点内容（嵌入用户提示词）；
 * - buildUserPrompt：组装用户提示词。
 *
 * 导出：
 * - SYSTEM_PROMPT
 * - buildValidationFeedback
 * - serializeCardContentContext / buildUserPrompt
 */

import type { CardContentContextEnvelope } from '../../../schemas/core-internal.js';
import type { PosttestGenerationInput } from '../schema/index.js';

export const SYSTEM_PROMPT = [
  '你是 LearnCraft 的 Node Tutor 后测设计师。最终只输出严格 JSON。',
  '请以给定的节点内容和 teaching_memory 作为主要出题依据；当你对某个事实、API 版本或边界不确定时，可以调用 tavily_search 核对，再回到节点内容范围出题。',
  '所有面向学习者的自然语言，包括题干、选项、解析与能力标签，必须使用简体中文；技术专有名词可保留英文。',
  '题干或解析需要展示代码时，使用标准 Markdown 三反引号代码围栏；JSON 字符串中的结构换行使用单层转义 \n，不能使用双重转义 \\n。',
  '你可以在需要时调用 tavily_search：工具结果会回传给你，请基于结果继续；不要为了调用工具而调用工具，也不要用同一个查询重复调用。',
  '当你已经能够给出完整答案时，直接输出最终 JSON：不要输出解释文字，也不要用 Markdown 围栏包裹。',
  '如果你收到一条用户消息指出上一次输出未通过字段校验并给出字段路径，请只修正这些路径对应的问题，然后重新输出完整 JSON。',
  'JSON 顶层只能包含 schema_version 和 questions；schema_version 固定为 assessment.single_choice.v1。',
  '每题只能包含 prompt、options、answer_key、explanation、skill_tags、max_score。',
  'options 必须是 2 至 6 个对象；每个 options 对象只能包含 key 和 text，key 必须是 A、B、C、D、E 或 F，text 必须是非空字符串。',
  'answer_key 必须是 options 中实际存在的 key；题目数量必须严格匹配请求。',
].join('');

/** 校验失败时回灌同一会话的观察文本；只暴露字段路径，不回显模型正文。 */
export function buildValidationFeedback(context: {
  turn: number;
  paths: readonly string[];
}): string {
  return [
    '第 ' + String(context.turn) + ' 轮输出未通过校验。校验失败的字段路径：'
      + (context.paths.slice(0, 8).join(', ') || 'response.json') + '。',
    '请只修正这些路径对应的问题，然后重新输出完整 JSON；题目数量必须与请求严格一致，并保留节点内容与 teaching_memory 作为出题依据。',
    '顶层只能是 schema_version、questions，schema_version 必须是 assessment.single_choice.v1；'
      + '每题只能包含 prompt、options、answer_key、explanation、skill_tags、max_score，options 必须是 {key,text} 对象数组。',
    '不要输出解释文字，也不要用 Markdown 围栏包裹 JSON。',
  ].join('\n');
}

/**
 * 按契约字段顺序序列化固定节点内容。
 * Python 用 orjson.dumps 输出紧凑 JSON，键序取自响应模型的字段定义；
 * 这里显式重排，保证嵌入提示词的文本与 Python 一致。
 */
export function serializeCardContentContext(context: CardContentContextEnvelope): string {
  return JSON.stringify({
    plan_node_id: context.plan_node_id,
    card_content_id: context.card_content_id,
    foundation: context.foundation,
    worked_example: context.worked_example,
    pitfalls_debug: context.pitfalls_debug,
    teaching_memory: context.teaching_memory,
  });
}

export function buildUserPrompt(input: PosttestGenerationInput, contentJson: string): string {
  return [
    '后测主题：' + input.topic,
    '题目数量：' + String(input.question_count),
    '难度：' + input.difficulty,
    '固定节点内容(JSON)：' + contentJson,
  ].join('\n');
}
