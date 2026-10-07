# LearnCraft 教学 Skill 来源与接入方案

> 文档状态：已实施第一期
>
> 更新时间：2026-10-03
>
> 适用范围：`apps/agent-worker-ts` 的学习知识生成与后测生成

## 一、结论

网上已经有可以直接阅读和复用的 Agent Skill，但没有一个现成 Skill 能直接符合 LearnCraft 当前的四条生成工作流和严格 JSON 合同。

最适合参考的是 [Education Agent Skills](https://github.com/GarethManning/education-agent-skills)。它提供标准 `SKILL.md` 文件，并包含渐进式提示、数字化示例、AI 反馈、错误分析、教回学习者等能力；仓库声明教育内容采用 CC BY-SA 4.0。它可以直接被通用 Agent 读取，但接入 LearnCraft 前仍需做合同和范围适配。

因此第一期采用“**外部 Skill 调研与借鉴，LearnCraft 内置中文实现**”的方式，不直接把第三方原文作为生产提示词。这样可以保持现有 `card_content.v2`、`learning_plan.v1` 和 `assessment.single_choice.v1` 合同不变。

## 二、已找到的可复用资源

| 资源 | 可直接使用的能力 | 许可证或限制 | 对 LearnCraft 的判断 |
| --- | --- | --- | --- |
| [Education Agent Skills](https://github.com/GarethManning/education-agent-skills) | [渐进提示](https://github.com/GarethManning/education-agent-skills/blob/main/skills/ai-learning-science/adaptive-hint-sequence-designer/SKILL.md)、[数字化示例](https://github.com/GarethManning/education-agent-skills/blob/main/skills/ai-learning-science/digital-worked-example-sequence/SKILL.md)、[AI 反馈](https://github.com/GarethManning/education-agent-skills/blob/main/skills/ai-learning-science/ai-feedback-design-principles/SKILL.md)、[错误分析](https://github.com/GarethManning/education-agent-skills/blob/main/skills/self-regulated-learning/error-analysis-protocol/SKILL.md)、[提示阶梯](https://github.com/GarethManning/education-agent-skills/blob/main/skills/student-learning/progressive-hint-ladder/SKILL.md)、[卡点诊断](https://github.com/GarethManning/education-agent-skills/blob/main/skills/student-learning/stuck-and-error-diagnosis-coach/SKILL.md)、[迁移桥](https://github.com/GarethManning/education-agent-skills/blob/main/skills/student-learning/transfer-bridge/SKILL.md) | CC BY-SA 4.0；每个 Skill 是独立 `SKILL.md`，无依赖 | 最接近四项需求，但需要改写成 LearnCraft 的中文输出规则和 JSON 约束。 |
| [AI Teaching Skills](https://github.com/bstellato/ai-teaching-skills) | `ai-socratic-tutor`、`ai-novice`、`ai-solution-study`；分别支持启发式追问、让学习者反向讲解、基于尝试修复第一处实质错误 | MIT；面向交互式学习对话 | 适合未来的 Tutor 对话，不直接适合当前一次性节点文档生成。 |
| [LearnLM-Inspired Tutor](https://github.com/unix2dos/skills/blob/main/learnlm-inspired-tutor/SKILL.md) | 根据学习者目标、水平和当前回答调整路线；区分知识缺口、部分理解、误区和认知负荷；使用最小有效提示 | 非官方、模型无关改编；当前查看页面未明确给出独立仓库许可证 | 适合提炼“起点适配”和“误区修复”规则，先不直接复制。 |
| [anything-to-course](https://github.com/lowwwbank/anything-to-course) | 尝试 → 原理 → worked example → 对比 → 渐隐支架 → 练习 → 反馈 → 重试；MIT | 是完整课程生成与学习状态工作流，包含间隔复习和学习记录 | 可借鉴“示例陪读”和“误区修复”，暂不引入其课程文件和状态系统。 |
| [school-skills/socratic-tutor](https://github.com/Jellypod-Inc/school-skills/blob/main/skills/socratic-tutor/SKILL.md) | 一次一个引导问题、提示阶梯、先看尝试再反馈、按学习阶段调整语言 | 当前只确认了公开 `SKILL.md`，接入前仍需核对许可证和版本 | 可借鉴人格与互动方式；不放入当前批量 JSON 生成链路。 |

## 三、四个 LearnCraft Skill 的来源映射

| LearnCraft Skill | 主要参考 | 第一阶段作用 |
| --- | --- | --- |
| 起点适配 | `LearnLM-Inspired Tutor` 的学习者建模；`adaptive-hint-sequence-designer` 的水平和卡点输入 | 根据现有画像、前测结果和可用时间调整解释深度、章节粒度和题目难度。 |
| 概念搭桥 | `anything-to-course` 的具体问题到抽象原理；`transfer-bridge` 的迁移思路 | 先说明问题和具体情境，再抽象概念，最后说明适用边界。 |
| 示例陪读 | `digital-worked-example-sequence`；`ai-novice` 的学习者讲解 | 对齐 `worked_example.files`、`entry_file` 和 `call_sequence`，解释每一步为什么发生。 |
| 误区修复 | `ai-feedback-design-principles`、`error-analysis-protocol`、`stuck-and-error-diagnosis-coach` | 将错误拆成理解错误、步骤错误和粗心错误，分别生成原因、验证方式和修复方法。 |

## 四、LearnCraft 内置目录

已在以下目录保存经过中文化和合同适配的本地 Skill：

```text
apps/agent-worker-ts/Skills/
├─ README.md
├─ learner-starting-point/SKILL.md
├─ concept-bridging/SKILL.md
├─ example-guidance/SKILL.md
└─ misconception-repair/SKILL.md
```

每个文件只描述风格、讲解重点和人格边界，不定义新的 API、数据库字段或模型工具。工作流决定角色、事实来源、生成步骤、输出字段和校验合同；Skill 不能改变这些内容。`README.md` 记录来源链接、许可证、改写范围和版本日期。

## 五、已实现的 Agent Worker 接入方式

1. `src/application/services/learning-skills.ts` 读取本地索引并固定允许加载上述四个目录。
2. `selectForWorkflow` 按 `context → content → repair` 层级和优先级选择 Skill。
3. 只有 `buildPromptSection` 才读取选中的 `SKILL.md`；未选中的正文不会进入上下文。
4. 选中的规则通过 `appendLearningSkillsToToolSection` 注入现有 `SYSTEM_PROMPT` 的 `#工具调用` 子区块。
5. Skill 是工作流的内部风格补充，不是 MCP 工具，不增加 Tavily 调用次数，也不能改变既有 JSON 合同。
6. Tavily 仍只用于近期版本、API 或不确定事实的核对；外部资料继续写入 `source_refs`。

## 六、工作流启用范围

| 工作流 | 启用 Skill |
| --- | --- |
| `card_content_generate` | 四个全部启用 |
| `plan_generate` | 起点适配、概念搭桥、误区修复 |
| `assessment_generate` | 起点适配、概念搭桥、误区修复 |
| `posttest_generate` | 起点适配、示例陪读、误区修复 |

现有角色人格继续保留。四个 Skill 只补充统一行为：使用具体证据进行反馈、不编造学习者经历、解释优先于评价、避免空泛夸奖。

## 七、范围和风险控制

- 不引入第三方 MCP 服务，不把远程 Skill 服务作为运行依赖。
- 不复制整个外部 Skill 仓库，只选择与 LearnCraft 目标直接相关的规则并改写。
- CC BY-SA 4.0 来源若有文字改写或复制，必须在 `Skills/README.md` 保留署名、来源和许可证说明，并确认是否接受相应的分享条款。
- 第三方 Skill 的输入输出格式不能直接覆盖 LearnCraft 的现有合同。
- 当前阶段不新增持续对话、学习记录、间隔复习或知识追踪；这些属于后续 Tutor 交互需求。

## 八、验证计划

- 检查四个 Skill 文件能够被 Worker 加载，缺失或为空时明确失败。
- 检查每个工作流只注入规定的 Skill。
- 检查提示词仍要求严格 JSON，且字段校验、工具上限和重试行为不变。
- 使用初学者和高级学习者各一组固定输入，比较解释深度、示例复杂度和题目难度是否发生预期变化。
- 使用包含具体错误的示例，检查 `pitfalls_debug`、后测干扰项和解析是否对应同一个误区。

第一期已完成索引、工作流选择、提示词注入和单元测试；完整 Worker 测试通过，类型检查和打包验证通过。
