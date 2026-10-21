---
name: example-guidance
description: 当节点内容需要解释代码入口、调用和状态变化，或后测需要引用已有示例时使用；不额外生成文件或运行日志。
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

## 按需参考

多文件示例或预期输出容易歧义时，参考调用顺序核对案例。见 [场景资料](references/walkthrough-review.md)。核心规则足够时不读取。

学习助手可调用 `load_skill`，传入 `skill_id: example-guidance` 和 `reference_id: walkthrough-review`；生成工作流无需加载此补充资料即可完成现有合同。
