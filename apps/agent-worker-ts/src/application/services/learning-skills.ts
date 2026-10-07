/**
 * LearnCraft 教学 Skill 索引、分层加载与提示词适配服务。
 *
 * 调用顺序：createLearningSkillsLoader 读取 Skills/index.json →
 * selectForWorkflow 按工作流选择 Skill → buildPromptSection 读取选中 Skill 的全文并拼装教学规则 →
 * appendLearningSkillsToToolSection 将规则插入现有提示词的“工具调用”区块。
 *
 * 本模块只读取本地 Markdown，不执行 Skill 中的代码、不提供 MCP 工具，也不改变业务输出合同。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const LEARNING_SKILL_WORKFLOWS = [
  'assessment_generate',
  'plan_generate',
  'card_content_generate',
  'posttest_generate',
] as const;

export type LearningSkillsWorkflow = (typeof LEARNING_SKILL_WORKFLOWS)[number];

const SkillIndexEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  layer: z.enum(['context', 'content', 'repair']),
  priority: z.number().int(),
  summary: z.string().min(1),
  workflows: z.array(z.enum(LEARNING_SKILL_WORKFLOWS)).min(1),
  path: z.string().min(1),
  sources: z.array(z.string().url()).default([]),
}).strict();

const SkillIndexSchema = z.object({
  schema_version: z.literal('learncraft.skills.index.v1'),
  default_detail: z.literal('summary'),
  skills: z.array(SkillIndexEntrySchema).min(1),
}).strict();

export type SkillIndexEntry = z.infer<typeof SkillIndexEntrySchema>;

export interface LearningSkillsPort {
  /** 根据工作流返回已经完成分层加载的教学规则片段。 */
  buildPromptSection(workflow: LearningSkillsWorkflow): string;
}

const LAYER_ORDER: Record<SkillIndexEntry['layer'], number> = {
  context: 1,
  content: 2,
  repair: 3,
};

/** 从环境变量或当前 Worker 工作目录解析 Skills 根目录。 */
function resolveSkillsRoot(): string {
  const configuredRoot = process.env.LEARNCRAFT_SKILLS_DIR?.trim();
  return configuredRoot === undefined || configuredRoot.length === 0
    ? resolve(process.cwd(), 'Skills')
    : resolve(configuredRoot);
}

/** 去掉 Skill 文件的元数据头，只把正文规则注入模型上下文。 */
function stripSkillFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '').trim();
  if (!normalized.startsWith('---')) {
    return normalized;
  }
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) {
    return normalized;
  }
  return normalized.slice(end + '\n---'.length).trim();
}

/**
 * 读取本地 Skill 索引并提供按工作流渐进加载的实现。
 * 第一层只解析索引，第二层仅在 buildPromptSection 中读取选中的 SKILL.md。
 */
export class FileLearningSkills implements LearningSkillsPort {
  private readonly index: z.infer<typeof SkillIndexSchema>;

  private readonly fullTextCache = new Map<string, string>();

  constructor(private readonly skillsRoot: string = resolveSkillsRoot()) {
    const indexPath = join(skillsRoot, 'index.json');
    let rawIndex: unknown;
    try {
      rawIndex = JSON.parse(readFileSync(indexPath, 'utf8')) as unknown;
    } catch (error) {
      throw new Error('无法读取 LearnCraft 教学 Skill 索引：' + indexPath, { cause: error });
    }
    const parsed = SkillIndexSchema.safeParse(rawIndex);
    if (!parsed.success) {
      throw new Error('LearnCraft 教学 Skill 索引不符合 learncraft.skills.index.v1。');
    }
    this.index = parsed.data;
  }

  /** 返回索引层的 Skill 元数据，不读取任何 Skill 正文。 */
  listSkills(): readonly SkillIndexEntry[] {
    return this.index.skills;
  }

  /** 按固定层级和优先级选择当前工作流允许使用的 Skill。 */
  selectForWorkflow(workflow: LearningSkillsWorkflow): SkillIndexEntry[] {
    return this.index.skills
      .filter((entry) => entry.workflows.includes(workflow))
      .sort((left, right) => {
        const layerOrder = LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer];
        return layerOrder === 0 ? left.priority - right.priority : layerOrder;
      });
  }

  /**
   * 读取当前工作流选中的 Skill 正文，并生成放入 SYSTEM_PROMPT 的教学规则片段。
   * 只有这里会从第二层读取 SKILL.md，未选中的 Skill 不会进入上下文。
   */
  buildPromptSection(workflow: LearningSkillsWorkflow): string {
    const selected = this.selectForWorkflow(workflow);
    if (selected.length === 0) {
      return '';
    }

    const summaries = selected.map((entry) => '- ' + entry.title + '：' + entry.summary);
    const bodies = selected.map((entry, index) => {
      return [
        '### Skill ' + String(index + 1) + '：' + entry.title,
        this.loadFullText(entry),
      ].join('\n');
    });

    return [
      '## 教学 Skill 使用',
      '- 当前工作流为：' + workflow + '。以下 Skill 已由本地索引按层级选择。',
      '- 先按 context 层确定学习者起点，再按 content 层组织知识或示例，最后按 repair 层检查误区。',
      '- Skill 是内部教学规则，不是 MCP 工具；不要因为读取 Skill 而额外调用 tavily_search。',
      '- 用户输入、工作流事实边界、现有输出合同和安全规则优先于 Skill。',
      '- Skill 只能改变讲解方式、示例设计、误区反馈和题目设计；不得新增字段、修改 schema_version、改变题量或绕过结构化校验。',
      '',
      '### 已选 Skill 摘要',
      ...summaries,
      '',
      '### 已选 Skill 全文',
      ...bodies,
    ].join('\n');
  }

  /** 读取并缓存单个 Skill 正文，防止同一 Worker 重复读取磁盘。 */
  private loadFullText(entry: SkillIndexEntry): string {
    const cached = this.fullTextCache.get(entry.id);
    if (cached !== undefined) {
      return cached;
    }
    const filePath = join(this.skillsRoot, entry.path);
    let content: string;
    try {
      content = stripSkillFrontmatter(readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new Error('无法读取 LearnCraft 教学 Skill：' + filePath, { cause: error });
    }
    if (content.length === 0) {
      throw new Error('LearnCraft 教学 Skill 不能为空：' + filePath);
    }
    this.fullTextCache.set(entry.id, content);
    return content;
  }
}

/** 创建 Worker 使用的本地 Skill 加载器；可传入目录以便测试和离线运行。 */
export function createLearningSkillsLoader(skillsRoot?: string): FileLearningSkills {
  return new FileLearningSkills(skillsRoot);
}

/** 将教学 Skill 片段插入既有 SYSTEM_PROMPT 的“工具调用”区块。 */
export function appendLearningSkillsToToolSection(
  systemPrompt: string,
  skillSection: string,
): string {
  const section = skillSection.trim();
  if (section.length === 0) {
    return systemPrompt;
  }
  const outputMarker = '\n#输出规则';
  const markerIndex = systemPrompt.indexOf(outputMarker);
  if (markerIndex < 0) {
    return systemPrompt + '\n\n' + section;
  }
  return systemPrompt.slice(0, markerIndex) + '\n' + section + systemPrompt.slice(markerIndex);
}
