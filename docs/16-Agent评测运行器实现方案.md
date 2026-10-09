# LearnCraft Agent 评测运行器实现方案

> 状态：待审查
>
> 更新时间：2026-10-08

## 一、目标

新增一个独立进程，用固定评测集调用现有四类业务工作流，再调用独立 LLM Judge，对结果进行五维质量评分。

本阶段不修改现有业务 Agent 的模型选择、工作流逻辑和数据库结构。

## 二、运行方式

评测进程启动时通过 `--owner-id` 指定用户：

```text
评测进程 --owner-id <用户ID> [--dataset <评测集文件>] [--output <结果目录>]
```

运行器使用该用户当前的默认模型连接调用业务工作流；Judge 使用 `AGENT_EVAL_JUDGE_*` 四个环境变量，二者完全隔离。

仓库根目录提供三个可重复执行的阶段命令：

```powershell
node scripts/agent-eval-command.mjs build
node scripts/agent-eval-command.mjs run --owner-id <用户UUID> --dataset evals/datasets/built.json --output evals/runs/smoke-001
node scripts/agent-eval-command.mjs score --owner-id <用户UUID> --dataset evals/datasets/built.json --output evals/runs/smoke-001
```

`build` 校验并标准化 `evals/datasets/default.json`，`run` 只生成并保存业务 Agent 候选结果，`score` 读取候选结果并调用 Judge；
三阶段分开保存，便于先人工检查候选输出，再重复评分。

## 三、处理流程

```text
读取评测集
  → 校验 case_id 和工作流输入
  → 使用 owner-id 的默认模型调用业务工作流
  → 检查候选结果的结构合同
  → 调用无工具 LLM Judge
  → 校验 Judge 返回的 1–5 分 JSON
  → 按 3/2/2/2/1 计算总分
  → 写入单次结果和汇总报告
```

Judge 只负责生成评测集草稿和五维评分，不调用 Tavily、数据库或其他工具。权重、总分、平均分和通过判断由运行器计算。

## 四、仓库文件

```text
evals/
├─ datasets/       # 评测集 JSON/JSONL
├─ runs/            # 单次运行结果
└─ reports/         # 汇总报告
```

评测集每条记录包含：`case_id`、`run_type`、输入快照、学习者画像、参考事实、必须覆盖的知识点和评分说明。

单次结果包含：业务模型信息、候选输出、结构校验结果、Judge 五维分数、评分理由、证据和加权总分。

## 五、评分规则

五个维度均为 1–5 分，权重如下：

```text
正确性 × 3
完整性 × 2
相关性 × 2
可读性 × 2
教学适配度 × 1
```

```text
加权分 = (正确性×3 + 完整性×2 + 相关性×2 + 可读性×2 + 教学适配度) / 10
百分制 = 加权分 / 5 × 100
```

结构校验失败的候选结果写入运行结果，但不进入正常质量平均分。

## 六、Judge 配置

独立进程直接使用 OpenAI 兼容接口：

```dotenv
AGENT_EVAL_JUDGE_BASE_URL=
AGENT_EVAL_JUDGE_API_KEY=
AGENT_EVAL_JUDGE_MODEL=
AGENT_EVAL_JUDGE_TEMPERATURE=0
```

Judge 不复用现有 `SafeModelEgressClient`、出网审计和模型限流。API Key 只从环境变量读取，不写入评测文件。

## 七、实现步骤

1. 定义评测集、单次结果和汇总报告的 JSON Schema；
2. 新增独立评测进程入口和 CLI 参数解析；
3. 根据 `--owner-id` 获取用户默认模型，并调用现有四类工作流；
4. 实现 Judge 的 OpenAI 兼容请求、JSON 解析和 1–5 分校验；
5. 实现加权计算、结果落盘和汇总报告；
6. 使用固定假模型和假 Judge 增加离线测试；
7. 再使用真实 Provider 运行小规模评测并人工复核结果。

## 八、暂不实现

- 不新增评测 Agent；
- 不修改现有业务工作流；
- 不修改数据库 Schema；
- 不把 Judge 接入线上用户请求；
- 不把 Judge 请求接入现有模型出网审计、限流或备用模型链路。
