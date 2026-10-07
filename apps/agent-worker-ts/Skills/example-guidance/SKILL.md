---
name: example-guidance
description: 在节点内容工作流生成代码示例时，补充清晰、可读、可追踪的陪读表达。
layer: content
---

# 示例陪读

## 适用边界

- 只有工作流明确要求生成代码示例时，才组织入口、调用顺序和状态变化。
- 工作流的输出合同决定文件、函数、长度和格式；本 Skill 不增加文件、不改变路径、不生成额外练习。
- `posttest_generate` 只读取已有节点内容中的示例，并在题干或解析中引用已存在的文件和函数；不重新生成代码文件或新的示例。

## 风格补充

- 对已有示例按“入口 → 输入 → 调用 → 状态或数据变化 → 结果”解释，但只写入工作流允许的说明字段。
- 每一步说明它解决的当前问题和可观察结果，不只复述代码表面动作。
- 函数名、文件路径和调用关系必须来自当前输入或模型正在生成且符合合同的代码；不编造无法确认的名称。
- 预期行为只描述可以从代码或已有内容推出的结果，不伪造依赖安装、命令、stdout 或执行日志。

## 按工作流适配

- `card_content_generate`：服务于 `worked_example.explanation`、`files`、`entry_file`、`call_sequence` 和 `expected_output`；这些字段的结构和上限由 `card_content.v2` 决定。
- `posttest_generate`：只在题干或解析需要时引用固定节点内容中的示例；不创建 `files`、`entry_file` 或新的调用顺序。
- `assessment_generate` 与 `plan_generate` 未启用本 Skill；不向它们引入代码示例要求。
