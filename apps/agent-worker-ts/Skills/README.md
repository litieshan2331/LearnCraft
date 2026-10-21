# LearnCraft 教学 Skill

本目录是教学 Skill 集合。每个子目录的 `SKILL.md` 是独立技能入口；本 README 是给维护者阅读的目录说明，添加 `name` 和 `description` 并不会把 README 变成可加载 Skill。

## 标准格式与可选资源

```text
skill-name/
├─ SKILL.md                 # 必需：元数据、核心规则、资源读取条件
├─ references/              # 可选：特定场景才需要的案例或详细约定
├─ scripts/                 # 可选：可重复执行的确定性任务，语言不限
├─ assets/                  # 可选：用于产物的模板、图片等资源
└─ agents/openai.yaml       # 可选：Codex 界面元数据，本 Worker 不读取
```

`references/` 是资料目录的惯用名称。没有具体用途时不创建空目录。教学策略主要由模型应用，本集合不需要执行脚本，也不为形式完整增加 Python 依赖；Worker 不执行 Skill 中的代码。

每个 `SKILL.md` 使用以下必需元数据：

```yaml
---
name: learner-starting-point
description: 当需要依据已提供的学习者画像调整解释深度时使用。
---
```

- `name` 使用小写字母、数字和连字符，长度不超过 64 个字符，与目录名和本项目索引的 `id` 一致。
- `description` 说明做什么、何时使用；完整规则和案例不放在摘要里。
- `layer`、`priority` 和 `workflows` 是 LearnCraft 的调度配置，放在 `index.json`，不是标准必需 frontmatter。
- 当前加载器剥离 frontmatter 后读取正文，运行时选择依据为索引；维护时需保持 `summary` 与对应 `description` 一致。

## 当前 Skill

| name | description | LearnCraft 层级 | 入口 |
| --- | --- | --- | --- |
| `learner-starting-point` | 当需要依据已提供的学习者画像、目标或前测结果调整解释深度时使用；保持既定难度和输出字段。 | `context` | [正文](learner-starting-point/SKILL.md) |
| `concept-bridging` | 当已有文本字段需要连接具体编程问题与抽象概念、解释类比边界时使用；适用于前测、路线和节点内容。 | `content` | [正文](concept-bridging/SKILL.md) |
| `example-guidance` | 当节点内容需要解释代码入口、调用和状态变化，或后测需要引用已有示例时使用；不额外生成文件或运行日志。 | `content` | [正文](example-guidance/SKILL.md) |
| `misconception-repair` | 当需要分析真实作答的错因，或在内容、题目和完成标准中表达常见误区及修复依据时使用。 | `repair` | [正文](misconception-repair/SKILL.md) |
| `socratic-tutoring` | 当学习助手需要围绕用户推演提出一个主要问题、按服务端等级给出渐进提示并验证后续表现时使用。 | `repair` | [正文](socratic-tutoring/SKILL.md) |

## 三层渐进式披露

### 第一层：名称与描述

`FileLearningSkills` 初始化时只读取 `index.json`，不读取 Skill 正文和参考资料。索引提供 `id`、`title`、`summary`、适用工作流、顺序和本地路径。学习助手模型先看到当前工作流允许的摘要。

`context → content → repair` 是教学规则的应用顺序，与以下资源披露层次不同。

### 第二层：SKILL.md 正文

- 四个生成工作流调用 `buildPromptSection(workflow)`，按工作流白名单、层级和优先级读取所选 Skill 正文，保持既有生成行为。
- 学习助手主 Agent 和子 Agent 可调用 `load_skill({"skill_id":"socratic-tutoring"})` 按需读取单个正文，不自动加载全部 Skill。
- 核心适用边界、工作流字段约束和教学规则保留在正文，不依赖参考资料才能完成基本任务。

### 第三层：支持资源

正文列出参考资料的相对链接、读取条件和注册 ID。需要场景案例时，学习助手继续调用同一个工具：

```json
{"skill_id":"socratic-tutoring","reference_id":"hint-ladder"}
```

这次只返回已登记的单份参考资料，不重复返回 Skill 正文，不自动跟随其他链接。只传 `skill_id` 的既有调用方式保持有效。四个生成工作流不新增参考资料工具，不自动注入第三层内容。

`index.json` 为每个 Skill 可选登记 `references`，每项含 `id`、`path` 和 `description`。它是项目本地的资源白名单扩展，旧索引没有该字段仍可加载。`path` 仅接受当前 Skill 的 `references/` 下单个 Markdown 文件名；模型只传注册 ID。

正文按 Worker 进程缓存；参考资料按需单独读取。读取结果由原有工具消息和轨迹机制处理，不作为学习者事实或掌握度证据，也不自动触发 Tavily。

## 加载边界与预算

- Skill 和参考资料继承相同的工作流白名单，读取前检查注册 ID 和真实路径，拒绝路径穿越与符号链接越界。
- 单份 Markdown 最大 64 KiB，空文件和不可读文件返回不可用错误，不向模型泄露文件系统异常细节。
- 不读取远程 `sources`，来源链接只用于署名和人工追溯。
- 不新增模型请求、不自动调用工具、不增加任何轮数或联网配额。模型主动读取参考资料仍占用现有对话 ReAct 轮数，需留出最终回复空间。
- 不修改业务 schema、输出字段、题量、权限或学习记忆写入规则。

## 维护与验证

1. 修改核心规则时编辑 `SKILL.md`；仅在特定场景需要时新增或修改参考资料，并在正文说明读取条件。
2. 名称、描述或适用范围变化时同步更新 `index.json` 和本 README；新增资料时登记 `references`。
3. 不复制同一份案例到正文和参考资料，不要求一次读取全部文件。
4. 使用 `skill-creator` 的 `scripts/quick_validate.py` 校验各 Skill；它检查格式，不能证明教学质量或运行时行为正确。
5. 修改加载代码时运行 `pnpm --filter @learncraft/agent-worker-ts typecheck`、`tests/learning-skills.test.ts` 和 `tests/learning-assistant.test.ts`；涉及工作流装配时构建验证。

## 来源与许可证

实现参考了以下公开资源，未将远程服务作为运行依赖：

- [Education Agent Skills](https://github.com/GarethManning/education-agent-skills)：CC BY-SA 4.0；参考渐进提示、数字化 worked example、AI 反馈、错误分析、提示阶梯和迁移桥。
- [AI Teaching Skills](https://github.com/bstellato/ai-teaching-skills)：MIT；参考学习者反向讲解和基于尝试的错误修复。
- [LearnLM-Inspired Tutor](https://github.com/unix2dos/skills/blob/main/learnlm-inspired-tutor/SKILL.md)：参考学习者适配、认知负荷和最小有效干预；该资源是非官方改编，本目录不复制其原文。
- [anything-to-course](https://github.com/lowwwbank/anything-to-course)：MIT；参考“尝试、原理、示例、练习、反馈、重试”的教学顺序。

本目录的中文规则是面向 LearnCraft 输出合同的改写版本。若继续复制或扩展 CC BY-SA 4.0 资源的原文，应保留署名并遵守其分享条款。
