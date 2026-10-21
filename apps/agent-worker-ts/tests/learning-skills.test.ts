/**
 * LearnCraft 教学 Skill 索引与渐进式加载测试。
 *
 * 调用顺序：createLoader 定位本地 Skills → listSkills / selectForWorkflow 检查索引分层 →
 * buildPromptSection 检查正文隔离 → 临时目录验证参考资料按需读取及路径边界 → 检查提示词区块适配。
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendLearningSkillsToToolSection,
  FileLearningSkills,
} from '../src/application/services/learning-skills.js';

/** 创建指向仓库内 Skills 目录的测试加载器。 */
function createLoader(): FileLearningSkills {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  return new FileLearningSkills(resolve(testDirectory, '../Skills'));
}

const temporaryDirectories: string[] = [];

/** 构造尚未写入正文或资料的索引，用文件缺失验证各层没有提前读取。 */
function createTemporarySkills(): { root: string; skill: string; reference: string; loader: FileLearningSkills } {
  const root = mkdtempSync(join(tmpdir(), 'learncraft-skills-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'demo', 'references'), { recursive: true });
  writeFileSync(join(root, 'index.json'), JSON.stringify({
    schema_version: 'learncraft.skills.index.v1', default_detail: 'summary',
    skills: [{ id: 'demo', title: '示例', layer: 'context', priority: 1, summary: '示例摘要',
      workflows: ['learning_assistant'], path: 'demo/SKILL.md', sources: [],
      references: [{ id: 'case', path: 'references/case.md', description: '需要案例时读取' }],
    }],
  }));
  return { root, skill: join(root, 'demo', 'SKILL.md'), reference: join(root, 'demo', 'references', 'case.md'), loader: new FileLearningSkills(root) };
}

/** 清理测试自己创建的临时资料。 */
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('FileLearningSkills', () => {
  /** 验证第一层索引暴露四个原有 Skill 和新增对话 Skill 的元数据。 */
  it('只从索引层列出教学 Skill 摘要', () => {
    const entries = createLoader().listSkills();

    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.id)).toEqual([
      'learner-starting-point',
      'concept-bridging',
      'example-guidance',
      'misconception-repair',
      'socratic-tutoring',
    ]);
    expect(entries.every((entry) => !('content' in entry))).toBe(true);
  });

  /** 对话模式按ID渐进加载，旧工作流不自动加载新对话 Skill。 */
  it('对话 Skill 可按需加载，拒绝模型指定任意路径', () => {
    const loader = createLoader();
    expect(loader.loadSkill('socratic-tutoring')).toContain('一个主要问题');
    expect(() => loader.loadSkill('../../.env')).toThrow('未注册');
    expect(() => loader.loadSkill('example-guidance', 'learning_assistant')).toThrow('不允许');
    expect(loader.selectForWorkflow('learning_assistant').map((item) => item.id)).toEqual(['learner-starting-point', 'misconception-repair', 'socratic-tutoring']);
    expect(loader.selectForWorkflow('assessment_generate').map((item) => item.id)).not.toContain('socratic-tutoring');
  });

  /** 索引、正文及参考资料独立读取，且缓存不会把参考内容混入正文。 */
  it('三层按需披露，不在初始化或正文加载时读取参考资料', () => {
    const f = createTemporarySkills();
    expect(f.loader.listSkills()[0]?.summary).toBe('示例摘要');
    writeFileSync(f.skill, '---\nname: demo\ndescription: 示例\n---\n核心规则');
    expect(f.loader.loadSkill('demo', 'learning_assistant')).toBe('核心规则');
    expect(f.loader.buildPromptSection('learning_assistant')).not.toContain('场景独有内容');
    writeFileSync(f.reference, '场景独有内容');
    expect(f.loader.loadSkill('demo', 'learning_assistant', 'case')).toBe('场景独有内容');
    expect(f.loader.loadSkill('demo', 'learning_assistant')).toBe('核心规则');
  });

  /** 参考资料继承工作流权限，不能用路径或其他 Skill 的 ID 绕过注册。 */
  it('参考资料必须注册且属于当前工作流', () => {
    const f = createTemporarySkills();
    expect(() => f.loader.loadSkill('demo', 'plan_generate', 'case')).toThrow('不允许');
    expect(() => f.loader.loadSkill('demo', 'learning_assistant', '../../secret')).toThrow('未注册');
    expect(() => createLoader().loadSkill('socratic-tutoring', 'learning_assistant', 'evidence-examples')).toThrow('未注册');
    expect(() => f.loader.loadSkill('demo', 'learning_assistant', 'case')).toThrow('无法读取');
  });

  /** 即使索引路径合法，符号链接也不能读到 Skill 目录外或资源根目录外。 */
  it.skipIf(process.platform === 'win32')('拒绝参考资料的符号链接越界', () => {
    const f = createTemporarySkills();
    writeFileSync(join(f.root, 'sibling.md'), '其他 Skill 的资料');
    symlinkSync(join(f.root, 'sibling.md'), f.reference);
    expect(() => f.loader.loadSkill('demo', 'learning_assistant', 'case')).toThrow('无法读取');
    rmSync(f.reference);
    const outside = mkdtempSync(join(tmpdir(), 'learncraft-outside-'));
    temporaryDirectories.push(outside);
    writeFileSync(join(outside, 'private.md'), '根目录外的资料');
    symlinkSync(join(outside, 'private.md'), f.reference);
    expect(() => f.loader.loadSkill('demo', 'learning_assistant', 'case')).toThrow('无法读取');
  });

  /** 空资料和超大文件不进入模型上下文。 */
  it('拒绝空白和超限参考资料', () => {
    const f = createTemporarySkills();
    writeFileSync(f.reference, '   ');
    expect(() => f.loader.loadSkill('demo', 'learning_assistant', 'case')).toThrow('不能为空');
    writeFileSync(f.reference, 'x'.repeat(65_537));
    expect(() => f.loader.loadSkill('demo', 'learning_assistant', 'case')).toThrow('无法读取');
  });

  /** 仓库中实际登记的资源均可加载，兼容原有两个参数的正文调用。 */
  it('读取真实 Skill 的所有登记资料', () => {
    const loader = createLoader();
    for (const skill of loader.listSkills()) {
      const workflow = skill.workflows[0]!;
      const body = loader.loadSkill(skill.id, workflow);
      expect(body).not.toMatch(/^---/);
      for (const reference of skill.references ?? []) {
        expect(body).toContain(reference.id);
        expect(loader.loadSkill(skill.id, workflow, reference.id).length).toBeGreaterThan(0);
      }
    }
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
