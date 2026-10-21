/**
 * 学习助手业务、Skill、Tavily 和两个委派工具的定义与可信执行。
 * 调用顺序：toolsForActor 暴露白名单 → executeReadTool 校验参数 → 注入服务端身份 → 合并可信证据。
 */
import type { ModelToolCall, ModelToolDefinition } from '../../../infrastructure/llm/model-gateway.js';
import { TAVILY_SEARCH_TOOL } from '../../../infrastructure/mcp/tavily-tool-gateway.js';
import { z } from 'zod';
import type { LearningAssistantDependencies } from '../ports.js';
import { BusinessArgumentsSchema, BusinessResultSchema, BusinessToolNameSchema, SkillArgumentsSchema, type Actor } from '../schemas/index.js';
import type { AssistantState, TrustedContext } from '../state.js';

const EMPTY = { type: 'object', properties: {}, additionalProperties: false };
export const DELEGATE_NAMES = ['analyze_wrong_answer', 'generate_socratic_question'] as const;
const READ_TOOLS: ModelToolDefinition[] = [
  { name: 'get_wrong_question', description: '读取当前会话关联的现有测评错题、用户作答和评分。', parameters: EMPTY },
  { name: 'get_user_profile', description: '读取当前用户必要画像；缺失字段保留为空。', parameters: EMPTY },
  { name: 'get_mastery_state', description: '读取当前目标或知识点的掌握度；不写入。', parameters: EMPTY },
  { name: 'get_learning_context', description: '读取当前会话相关的学习经历与验证记录。', parameters: EMPTY },
  { name: 'load_skill', description: '按注册 skill_id 读取教学 Skill 正文；需要其中链接的场景资料时，再传已登记的 reference_id 单独读取。只影响教学方式，不执行脚本。', parameters: { type: 'object', properties: { skill_id: { type: 'string' }, reference_id: { type: 'string', description: '可选，仅使用 Skill 正文列出的参考资料 ID，禁止文件路径。' } }, required: ['skill_id'], additionalProperties: false } },
  TAVILY_SEARCH_TOOL,
];
const DELEGATE_TOOLS: ModelToolDefinition[] = DELEGATE_NAMES.map((name) => ({ name, description: name === 'analyze_wrong_answer' ? '委派错题归因子 Agent，返回假设、来源证据及验证方向。' : '委派苏格拉底导师子 Agent，返回一个主要问题、提示和验证目标。', parameters: { type: 'object', properties: { task: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['task'], additionalProperties: false } }));

/** 主 Agent 可委派；子 Agent 仅能使用读工具，无法互相调用。 */
export function toolsForActor(actor: Actor): ModelToolDefinition[] {
  return actor === 'main' ? [...READ_TOOLS, ...DELEGATE_TOOLS] : [...READ_TOOLS];
}

/** 合并来源证据，保留先前用户解释；跨题清理由 prepare 节点完成。 */
function mergeContext(context: TrustedContext, name: string, data: unknown, evidence: TrustedContext['evidence']): TrustedContext {
  const all = new Map(context.evidence.map((item) => [item.id, item]));
  for (const item of evidence) all.set(item.id, item);
  return { facts: { ...context.facts, [name]: data }, evidence: [...all.values()] };
}

/** 执行只读工具；模型永远不能传用户身份，网页不进入用户修复证据集合。 */
export async function executeReadTool(deps: LearningAssistantDependencies, state: AssistantState, call: ModelToolCall): Promise<{ result: unknown; context: TrustedContext }> {
  const args: unknown = JSON.parse(call.argumentsJson);
  const businessName = BusinessToolNameSchema.safeParse(call.name);
  if (businessName.success) {
    BusinessArgumentsSchema.parse(args);
    const output = BusinessResultSchema.parse(await deps.readBusinessTool(businessName.data, state.input));
    return { result: output, context: mergeContext(state.context, call.name, output.data, output.evidence) };
  }
  if (call.name === 'load_skill') {
    const { skill_id, reference_id } = SkillArgumentsSchema.parse(args);
    try {
      const content = deps.skills.loadSkill(skill_id, 'learning_assistant', reference_id);
      return { result: { skill_id, ...(reference_id === undefined ? {} : { reference_id }), content }, context: state.context };
    } catch {
      return { result: { ok: false, code: 'SKILL_UNAVAILABLE', message: '该 Skill 或参考资料未注册、不适用或不可读取' }, context: state.context };
    }
  }
  if (call.name === 'tavily_search') {
    z.object({ query: z.string().trim().min(1).max(500) }).strict().parse(args);
    return { result: await deps.tavily.execute(call), context: state.context };
  }
  throw new Error('工具不在当前 Agent 白名单内：' + call.name);
}
