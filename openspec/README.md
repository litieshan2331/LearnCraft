# LearnCraft OpenSpec 目录

本目录存放 LearnCraft 的 OpenSpec 规划资料。模型处理需求时，应先阅读本文件，再根据任务进入对应子目录。

## 目录结构

- `config.yaml`：OpenSpec 工作流和文档语言配置。
- `changes/`：进行中的变更提案、设计、规格增量和任务清单。
- `changes/archive/`：已经完成并归档的变更。
- `specs/`：当前项目的正式能力规格。

## 常用命令

```bash
# 查看当前变更和 OpenSpec 根目录
openspec list --json

# 创建新的变更目录
openspec new change "变更名称" --description "变更目的"

# 查看变更状态
openspec status --change "变更名称" --json

# 校验变更或规格
openspec validate "变更名称"
openspec validate --specs
```

OpenSpec 工作流说明由 `.agents/skills/` 中的技能文件提供。不要手工创建 `changes/` 下的变更目录；应使用 `openspec new change`，以便同时生成所需的元数据。
