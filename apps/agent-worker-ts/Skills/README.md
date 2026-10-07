# LearnCraft 教学 Skill

本目录保存 Agent Worker 使用的教学规则。Skill 不是 MCP 工具，也不负责联网、持久化或修改业务合同；它们只约束知识讲解、示例设计、误区反馈和题目设计。

## 分层与加载

- `index.json` 是第一层：只保存 Skill 名称、摘要、适用工作流、优先级和来源。
- 每个 Skill 的 `SKILL.md` 是第二层：只有被当前工作流选中时才读取全文并注入模型提示词。
- 选择由 Worker 的固定工作流映射完成，用户输入不能指定任意文件路径。
- 四个 Skill 的正文都包含“结构化输出适配”，不得新增 JSON 字段、修改 `schema_version` 或绕过 Zod 校验。

## 当前 Skill

- `learner-starting-point`：根据学习者起点调整解释深度、章节粒度和题目难度。
- `concept-bridging`：把具体问题、代码情境和抽象概念连接起来，并说明类比边界。
- `example-guidance`：按入口、调用、状态变化和结果组织可读的代码示例。
- `misconception-repair`：识别具体误区，说明原因、验证方式和修复方法。

## 来源与许可证

实现参考了以下公开资源，未将远程服务作为运行依赖：

- [Education Agent Skills](https://github.com/GarethManning/education-agent-skills)：CC BY-SA 4.0；参考渐进提示、数字化 worked example、AI 反馈、错误分析、提示阶梯和迁移桥。
- [AI Teaching Skills](https://github.com/bstellato/ai-teaching-skills)：MIT；参考学习者反向讲解和基于尝试的错误修复。
- [LearnLM-Inspired Tutor](https://github.com/unix2dos/skills/blob/main/learnlm-inspired-tutor/SKILL.md)：参考学习者适配、认知负荷和最小有效干预；该资源是非官方改编，本目录不复制其原文。
- [anything-to-course](https://github.com/lowwwbank/anything-to-course)：MIT；参考“尝试、原理、示例、练习、反馈、重试”的教学顺序。

本目录的中文规则是面向 LearnCraft 输出合同的改写版本。若继续复制或扩展 CC BY-SA 4.0 资源的原文，应保留署名并遵守其分享条款。
