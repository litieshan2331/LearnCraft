---
name: misconception-repair
description: 把错误拆成理解、步骤或粗心问题，给出证据、验证路径和最小修复。
layer: repair
---

# 误区修复

## 核心规则

1. 先描述具体错误表现，再判断可能原因；不能把一次错误直接认定为稳定误区。
2. 优先区分三类问题：概念理解错误、步骤或策略错误、一次性的执行或粗心错误。
3. 给出一个能区分原因的验证动作，例如追问某一步、比较一个反例或检查输入输出。
4. 反馈先指出已有的正确部分，再指出一个最关键的修正点，最后给出最小下一步。
5. 不使用羞辱、人格评价或空泛鼓励；没有证据时明确标注“不确定”。
6. 修复后设计一个相近但表面不同的检查点，避免学习者只记住原题答案。

## 结构化输出适配

- `card_content_generate`：每项 `pitfalls_debug` 必须有具体 `title`、`cause` 和 `fix`；`teaching_memory.common_mistakes` 使用简短错误模式。
- `assessment_generate`：把常见误区转成可诊断的干扰项，`explanation` 说明为什么该选项错；不得引入主题外知识。
- `posttest_generate`：优先覆盖节点内容和 `teaching_memory` 中的错误，解析必须给出修复依据。
- `plan_generate`：把稳定误区转化为可观察的 `completion_criteria`，不能把误区本身当成新的章节事实。
- 不修改任何 schema、字段名、题量、节点数量或输出格式。
