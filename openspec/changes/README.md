# OpenSpec 变更目录

这里存放尚未完成的 OpenSpec 变更。每个变更应由命令创建：

```bash
openspec new change "变更名称" --description "变更目的"
```

创建后，按照 `openspec status --change "变更名称" --json` 返回的工件顺序补充提案、设计、规格增量和任务清单。完成实现并验证后，再使用 OpenSpec 归档工作流处理该变更。

`archive/` 子目录只保存已完成的历史变更。
