/**
 * LearnCraft 教学 Skill 索引与渐进式加载测试。
 *
 * 调用顺序：createLoader 定位本地 Skills → listSkills / selectForWorkflow 检查索引分层 →
 * buildPromptSection 检查仅注入当前工作流需要的正文 → appendLearningSkillsToToolSection 检查提示词区块适配。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  appendLearningSkillsToToolSection,
  FileLearningSkills,
} from '../src/application/services/learning-skills.js';

/** 创建指向仓库内 Skills 目录的测试加载器。 */
function createLoader(): FileLearningSkills {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  return new FileLearningSkills(resolve(testDirectory, '../Skills'));
}

describe('FileLearningSkills', () => {
  /** 验证第一层索引只暴露四个 Skill 的元数据。 */
  it('只从索引层列出四个教学 Skill', () => {
    const entries = createLoader().listSkills();

    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.id)).toEqual([
      'learner-starting-point',
      'concept-bridging',
      'example-guidance',
      'misconception-repair',
    ]);
    expect(entries.every((entry) => !('content' in entry))).toBe(true);
  });

  /** 验证不同工作流按固定层级选择不同 Skill，未选 Skill 不进入上下文。 */
  it('按工作流和层级选择 Skill', () => {
    const loader = createLoader();

    expect(loader.selectForWorkflow('card_content_generate').map((entry) => entry.id)).toEqual([
      'learner-starting-point',
      'concept-bridging',
      'example-guidance',
      'misconception-repair',
    ]);
    expect(loader.selectForWorkflow('plan_generate').map((entry) => entry.id)).toEqual([
      'learner-starting-point',
      'concept-bridging',
      'misconception-repair',
    ]);
  });

  /** 验证渐进披露只把当前工作流选中的 Skill 正文注入提示词片段。 */
  it('只加载当前工作流需要的 Skill 正文', () => {
    const loader = createLoader();
    const planSection = loader.buildPromptSection('plan_generate');
    const cardSection = loader.buildPromptSection('card_content_generate');

    expect(planSection).toContain('### Skill 1：起点适配');
    expect(planSection).toContain('### Skill 2：概念搭桥');
    expect(planSection).not.toContain('### Skill 3：示例陪读');
    expect(cardSection).toContain('### Skill 3：示例陪读');
    expect(cardSection).toContain('### Skill 4：误区修复');
    expect(cardSection).toContain('不得新增字段');
  });

  /** 验证 Skill 规则被放进既有工具调用区块，而不是覆盖输出合同。 */
  it('把 Skill 片段插入工具调用区块', () => {
    const prompt = '前文\n#工具调用\n- 可以检索\n#输出规则\n- 只输出 JSON';
    const result = appendLearningSkillsToToolSection(prompt, '## 教学 Skill 使用\n- 先适配起点');

    expect(result).toContain('#工具调用\n- 可以检索\n## 教学 Skill 使用');
    expect(result).toContain('## 教学 Skill 使用\n- 先适配起点\n#输出规则');
  });
});
