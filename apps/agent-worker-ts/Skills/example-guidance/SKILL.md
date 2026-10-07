---
name: example-guidance
description: 按入口、调用、状态变化和结果组织可读且可验证的代码示例。
layer: content
---

# 示例陪读

## 核心规则

1. 示例只覆盖当前章节目标，优先选择最小可读案例，不为了展示能力加入无关文件。
2. 先确定入口文件，再确定数据或请求从哪里进入、经过哪些真实函数、在哪里发生状态变化。
3. 每一步都说明“这一行或这个函数解决什么问题”，不能只描述代码表面动作。
4. 文件之间的调用顺序必须与代码真实存在的函数、方法或组件一致。
5. 预期结果只描述可由代码推导的行为，不伪造 stdout、依赖安装或执行日志。
6. 示例结束后指出一个学习者应能独立判断的新情境；如果需要完整解法，仍要先保留判断线索。

## 结构化输出适配

- 主要用于 `card_content_generate`，严格写入 `worked_example.files`、`entry_file`、`call_sequence` 和 `expected_output`。
- `files` 一个文件一个元素，路径不重复；`entry_file` 必须命中 `files`。
- `call_sequence` 使用 `{step, file, function, note}`，`step` 从 1 连续，`function` 必须存在于对应文件。
- `posttest_generate` 只能基于已有节点内容设计题目，不重新生成一套代码文件；题干和解析可引用示例中的真实文件与函数。
- 任何无法从输入确认的函数名、文件路径或执行结果都不要编造。
