# LearnCraft Agent 日志设计

> 文档状态：P0 日志目标与当前实现边界
> 更新日期：2026-09-14
> 适用范围：学习规划 Agent、节点教学 Agent 及其 Tavily 兜底流程

本文定义 Agent 的内部运行日志目标。日志用于追踪模型调用、工具调用、校验、修复、上下文交接和最终持久化，不用于向用户展示生成过程。正常生成和 Tavily 兜底生成对用户保持相同的业务体验；区别只记录在 `AgentRun` 事件和结构化日志中。

当前 P0 已持久化的生命周期事件是 `run.queued`、`run.started`、`run.resumed`、`run.retry_scheduled`、`run.succeeded`、`run.failed` 和 `run.cancelled`，以及安全的运行摘要与错误摘要。下文的 `model_call_*`、`tool_call_*`、`validation_failed` 等细粒度事件是**后续实现目标**，尚未由当前 Worker 逐步写入 `agent_run_events`；不能把示例字段当作当前数据库已有数据。

## 1. 两个逻辑 Agent

### 1.1 学习规划 Agent

学习规划 Agent 使用 `learning_architect` 作为内部 Agent 角色，在同一个 `goal_id` 逻辑会话中负责两个阶段：

| 阶段 | `run_type` | 触发时机 | 主要输出 |
| --- | --- | --- | --- |
| 前测生成 | `assessment_generate` | 用户请求前测 | 10–20 道单选题、隐藏答案、逐题解析、能力标签 |
| 路线生成 | `plan_generate` | 用户提交前测并主动确认生成路线 | 6–12 个书籍式章节节点、`node_brief`、前置依赖和完成标准 |

这两个阶段可以创建两个不同的 `AgentRun`，但必须共享：

- `agent_role = learning_architect`；
- `logical_session_key = goal:{goal_id}`；
- 画像版本和输入快照引用；
- 前测阶段与路线阶段之间的结构化交接引用。

这里的“同一个 Agent”指同一个业务 Agent、同一套执行 Profile 和同一个目标上下文，不要求两个用户操作共用同一个长时间运行中的 Celery 任务。

### 1.2 节点教学 Agent

节点教学 Agent 使用 `node_tutor` 作为内部 Agent 角色，在同一个 `plan_node_id` 逻辑会话中负责两个阶段：

| 阶段 | `run_type` | 触发时机 | 主要输出 |
| --- | --- | --- | --- |
| 节点知识生成 | `card_content_generate` | 用户首次打开节点 | `foundation`、`worked_example`、`pitfalls_debug`、引用和 `teaching_memory` |
| 节点后测生成 | `posttest_generate` | 节点内容 ready 后用户主动选择后测 | 5–10 道单选题、隐藏答案、逐题解析 |

节点内容和节点后测可以创建不同的 `AgentRun`，但必须共享：

- `agent_role = node_tutor`；
- `logical_session_key = node:{plan_node_id}`；
- 当前节点、目标和画像的结构化快照；
- 节点内容的 `card_content_id`；
- `teaching_memory` 和引用快照；

节点后测只基于已经保存的节点内容、`worked_example` 和 `teaching_memory`。如果兜底阶段需要调用 Tavily MCP，其作用只能是帮助恢复结构或阅读已有引用来源，不得把无关的新知识直接加入后测事实范围。

## 2. 日志原则

1. 每一个模型长任务都创建 `AgentRun`，并以 `agent_run_id` 贯穿 Web、Outbox、Dispatcher、Celery、Worker、模型和 Core API。
2. 细粒度日志实现后，每次 Agent 调用、工具调用、校验和持久化都应写结构化事件；事件按时间顺序追加，不覆盖历史。
3. Tavily 是否开放由具体工作流阶段决定：前测首轮和最终恢复阶段开放、修复阶段不开放；后测首轮不开放、修复和最终恢复阶段开放；路线和节点内容首轮开放、修复阶段不开放、最终恢复阶段强制执行 Tavily。
4. 当首轮和修复结果均未通过校验时，进入最终恢复阶段。前测和后测在该阶段开放 Tavily 供模型自主决定；路线和节点内容在该阶段强制 Tavily 恢复。恢复结果必须再次校验，不能把未通过的结果写入业务表。
5. 只有通过最终校验的结构化结果才能调用 Core API 持久化；无效 JSON、无效路线、无效题目和无效内容不得写入业务表。
6. 用户侧只读取已验证结果和 AgentRun 状态，不读取原始 Prompt、模型增量输出、工具原文或内部错误堆栈。
7. 日志不得记录 API Key、完整 Prompt、隐藏答案、用户完整私密资料、完整模型响应或未经脱敏的网页正文。

## 3. 通用事件字段

每条 Agent 事件建议包含以下字段：

| 字段 | 说明 |
| --- | --- |
| `event_id` | 事件唯一 ID |
| `event_type` | 事件类型 |
| `occurred_at` | UTC 时间 |
| `trace_id` | 一次用户请求链路的追踪 ID |
| `agent_run_id` | 当前 AgentRun |
| `agent_role` | `learning_architect` 或 `node_tutor` |
| `run_type` | `assessment_generate`、`plan_generate`、`card_content_generate` 或 `posttest_generate` |
| `logical_session_key` | `goal:{goal_id}` 或 `node:{plan_node_id}` |
| `attempt` | 首轮为 0，修复轮次从 1 开始 |
| `generation_path` | `model_knowledge`、`model_with_tavily` 或 `tavily_recovery` |
| `step` | 工作流节点，如 `input_normalizer`、`generator`、`validator` |
| `duration_ms` | 当前步骤耗时 |
| `error_category` | 可重试、校验、超时、工具或权限错误分类 |

事件的 `input_summary` 和 `output_summary` 只保存摘要、哈希、数量、版本和资源 ID，不保存敏感原文。

## 4. 工具调用记录

Tavily 搜索和资源阅读属于同一个 MCP 工具服务，不拆成两个 Agent。工具事件建议使用：

- `tool_call_started`；
- `tool_call_completed`；
- `tool_call_failed`。

推荐字段：

```json
{
  "event_type": "tool_call_completed",
  "provider": "tavily_mcp",
  "operations": ["search", "read"],
  "trigger": "model_decision",
  "query_hash": "sha256:...",
  "source_count": 4,
  "source_ids": ["source:1", "source:2"],
  "latency_ms": 820,
  "response_bytes": 18420
}
```

`trigger` 使用以下值区分原因：

- `model_decision`：当前阶段向模型开放工具，由模型自行决定调用；
- `final_validation_failed`：主流程最终校验仍不合法，工作流进入最终恢复阶段；路线和内容会强制 Tavily，前测和后测由模型自主决定；
- `retry_after_tool_error`：工具调用失败后的基础设施重试。

不得把 `query` 原文、完整网页内容或 API 凭据写入普通应用日志；如确需审计，保存经过脱敏和访问控制的来源摘要。

### 4.1 Tavily 检索顺序

Tavily MCP 的连接配置、认证方式、超时、预算、调用次数和安全出网参数沿用项目现有配置，本日志设计不重复定义。工具调用顺序沿用“先广搜、后缩搜”：

1. 广搜学习目标、章节主题或节点问题，获取候选权威来源；
2. 缩搜候选来源、章节标题、引用定位和缺失信息；
3. 阅读最终来源并记录来源 ID、版本、耗时和摘要哈希；
4. 将结构化资料交给当前 Agent 重建结果，再执行最终校验。

是否开放 Tavily 由工作流阶段决定；具体工作流应记录实际发生的搜索、缩搜和资源阅读事件链，不能仅根据“恢复”名称推断已经调用 Tavily。

## 5. 学习规划 Agent：前测生成日志

### 5.1 业务触发

```text
POST /api/v1/learning-goals/{goal_id}/assessment-runs
        │
        ▼
Web 创建 assessment_generate AgentRun + Outbox
        │
        ▼
Dispatcher → Celery → learning_architect
```

### 5.2 日志顺序

1. `agent_run_created`：记录 `assessment_generate`、`agent_role=learning_architect`、`logical_session_key=goal:{goal_id}`、幂等键和输入快照引用。
2. `agent_run_started`：记录 Worker、队列任务 ID 和 Profile 版本；当前 P0 未记录或恢复 Checkpoint。
3. `input_normalized`：记录目标摘要、画像版本、题量范围、难度策略和输入哈希；不记录用户完整画像原文。
4. `model_call_started`：记录模型连接 ID、模型名、Profile 版本、Prompt 版本、最大 Token、超时和工具白名单。
5. `tool_call_*`：如果模型主动调用 Tavily，记录 `trigger=model_decision`、搜索/阅读操作、来源数量和耗时。
6. `model_call_completed`：只记录响应大小、Token、费用估算和响应哈希，不记录原始答案内容。
7. `assessment_schema_validated`：记录题目数量、题型、选项数量和隐藏答案/解析字段是否齐全。
8. 如果校验失败，记录 `validation_failed`，随后记录 `repair_started`、修复模型调用和再次校验；前测共享题集管线的修复阶段不开放 Tavily。
9. 若修复后仍不合法，记录最终恢复事件；前测共享题集管线的最终恢复阶段开放 Tavily，由模型自主决定是否调用，再记录 `assessment_reconstructed` 和恢复后最终校验结果。
10. `core_persist_started`：只发送已验证题目、隐藏答案、解析、能力标签、画像版本和输入快照引用。
11. `core_persist_completed`：记录 `assessment_id`、题目数量和版本。
12. `agent_run_succeeded`：记录状态、总耗时、总 Token、费用估算、修复次数、工具调用次数和 `generation_path`。

### 5.3 前测日志示例

```json
{
  "event_type": "agent_run_succeeded",
  "agent_run_id": "run_pretest_001",
  "agent_role": "learning_architect",
  "run_type": "assessment_generate",
  "logical_session_key": "goal:goal_123",
  "generation_path": "model_knowledge",
  "fallback_used": false,
  "assessment_id": "assessment_123",
  "question_count": 12,
  "repair_attempts": 0,
  "tool_call_count": 0,
  "total_tokens": 2840,
  "estimated_cost_usd": 0.012,
  "status": "succeeded"
}
```

如果模型在已开放工具的阶段自行使用 Tavily，将 `generation_path` 记为 `model_with_tavily`；如果进入最终恢复阶段并实际调用 Tavily，则记为 `tavily_recovery`。如果最终恢复阶段开放了 Tavily 但模型没有调用，仍应以实际工具事件为准。

## 6. 学习规划 Agent：路线生成日志

### 6.1 业务触发

```text
用户提交前测并确认生成路线
        │
        ▼
Web 创建 plan_generate AgentRun + Outbox
        │
        ▼
Dispatcher → Celery → learning_architect
```

### 6.2 日志顺序

1. `agent_run_created`：记录 `plan_generate`、`agent_role=learning_architect`、同一个 `logical_session_key=goal:{goal_id}`，以及 `assessment_id`、前测评分摘要和 `parent_agent_run_id`。
2. `agent_run_started`：记录 Worker、队列任务 ID 和路线生成 Profile 版本；当前 P0 未恢复 Checkpoint。
3. `context_loaded`：记录目标、画像版本、前测交接快照 ID、薄弱点摘要和输入哈希。
4. `model_call_started`：记录模型、Prompt 版本、输出 Schema、预算和工具策略。
5. `tool_call_*`：仅首轮由模型自行决定是否调用 Tavily；修复阶段不开放工具。
6. `model_call_completed`：记录 Token、费用估算、响应哈希和输出大小。
7. `plan_schema_validated`：记录节点数量、章节标题数量、依赖边数量、主题覆盖摘要和 Schema 版本。
8. `plan_business_validated`：记录顺序、依赖无环、前置节点存在性、时长范围和 `node_brief` 完整性。
9. 校验失败时记录 `validation_failed` 和错误代码；修复阶段不开放 Tavily。
10. 若主流程最终校验仍不合法，记录 `fallback_triggered`，强制调用 Tavily MCP 搜索和阅读权威目录或资料，再记录 `plan_reconstructed` 和兜底后最终校验。
11. `core_persist_started`：只经 Core API 写入合法的路线快照、节点、依赖和 `node_brief`。
12. `core_persist_completed`：记录 `learning_plan_id`、节点数量和路线版本。
13. `agent_run_succeeded`：记录最终状态、生成路径、修复次数、工具调用次数和成本摘要。

### 6.3 路线日志示例

```json
{
  "event_type": "agent_run_succeeded",
  "agent_run_id": "run_plan_001",
  "parent_agent_run_id": "run_pretest_001",
  "agent_role": "learning_architect",
  "run_type": "plan_generate",
  "logical_session_key": "goal:goal_123",
  "generation_path": "tavily_recovery",
  "fallback_used": true,
  "learning_plan_id": "plan_123",
  "node_count": 8,
  "repair_attempts": 2,
  "tool_calls": ["tavily_mcp.search", "tavily_mcp.read"],
  "validation_errors_before_fallback": ["prerequisite_node_missing"],
  "status": "succeeded"
}
```

## 7. 节点教学 Agent：知识生成日志

### 7.1 业务触发

```text
用户首次打开节点
        │
        ▼
Web 创建 card_content_generate AgentRun + Outbox
        │
        ▼
Dispatcher → Celery → node_tutor
```

同一节点已经存在成功内容时，Web 不创建新的内容生成任务，直接返回既有 `card_content_id`。失败记录允许重试，但成功内容不能被第二次生成覆盖。

### 7.2 日志顺序

1. `agent_run_created`：记录 `card_content_generate`、`agent_role=node_tutor`、`logical_session_key=node:{plan_node_id}` 和幂等键。
2. `agent_run_started`：记录 Worker、队列任务 ID 和内容生成 Profile 版本；当前 P0 未恢复 Checkpoint。
3. `context_loaded`：记录 `plan_node_id`、`node_brief` 摘要、目标和画像版本、受控资料集合版本；不记录完整私密资料。
4. `model_call_started`：记录模型、Prompt 版本、内容 Schema、引用要求、预算和工具策略。
5. 如果模型自主调用 Tavily，记录 `tool_call_started/completed`；如果没有调用，则不补造工具事件。
6. `model_call_completed`：记录 Token、费用估算、响应哈希和大小。
7. `content_schema_validated`：校验 `foundation`、`worked_example`、`pitfalls_debug`、`source_refs` 和 `teaching_memory`。
8. `content_reference_validated`：校验引用来源、定位信息和内容与来源的对应关系。
9. 校验失败时记录 `validation_failed`，最多执行一次无工具结构化修复；仍失败后进入强制 Tavily 恢复。
10. 若主流程最终校验仍不合法，记录 `fallback_triggered`，强制调用 Tavily MCP 搜索和阅读资料，再记录 `content_reconstructed` 和兜底后最终校验。
11. `core_persist_started`：只写入已验证的内容、引用、`worked_example` 和 `teaching_memory`。
12. `core_persist_completed`：记录唯一成功的 `card_content_id`。
13. `agent_run_succeeded`：记录状态、路径、修复次数、工具调用次数和成本摘要。

### 7.3 内容日志示例

```json
{
  "event_type": "agent_run_succeeded",
  "agent_run_id": "run_content_001",
  "agent_role": "node_tutor",
  "run_type": "card_content_generate",
  "logical_session_key": "node:node_123",
  "generation_path": "model_with_tavily",
  "fallback_used": false,
  "card_content_id": "content_123",
  "sections": ["foundation", "worked_example", "pitfalls_debug"],
  "source_ref_count": 3,
  "repair_attempts": 1,
  "tool_calls": ["tavily_mcp.search", "tavily_mcp.read"],
  "status": "succeeded"
}
```

## 8. 节点教学 Agent：后测生成日志

### 8.1 业务触发

```text
节点内容 ready 后，用户主动选择生成后测
        │
        ▼
Web 创建 posttest_generate AgentRun + Outbox
        │
        ▼
Dispatcher → Celery → node_tutor
```

后测不是节点内容生成完成后的自动步骤。每次用户主动重练都创建新的 `Assessment` 和新的 `posttest_generate AgentRun`，保留历史题集和作答记录。

### 8.2 日志顺序

1. `agent_run_created`：记录 `posttest_generate`、`agent_role=node_tutor`、`logical_session_key=node:{plan_node_id}`、`source_card_content_id` 和题量范围。
2. `agent_run_started`：记录 Worker、队列任务 ID 和后测 Profile 版本；当前 P0 未恢复 Checkpoint。
3. `context_loaded`：记录固定内容版本、`worked_example` 摘要版本、`teaching_memory` 版本、引用快照和题集序号。
4. `model_call_started`：记录模型、Prompt 版本、后测 Schema、预算和工具策略。
5. 后测首轮不开放 Tavily；修复和最终恢复阶段可以开放，由模型自主决定是否调用。若调用，记录其搜索/阅读事件。Tavily 资料不得改变后测以固定节点内容、`worked_example` 和 `teaching_memory` 为主要依据的业务边界。
6. `model_call_completed`：记录 Token、费用估算、响应哈希和输出大小。
7. `assessment_schema_validated`：校验题量、单选题类型、选项数量、难度和隐藏答案/解析。
8. 校验失败时记录 `validation_failed`，并执行有限修复；是否开放 Tavily 按该工作流阶段策略记录。
9. 若修复后仍不合法，记录最终恢复事件；是否实际调用 Tavily 必须以工具事件为准，不能仅凭阶段名称假设已经联网。
10. `core_persist_started`：只写入已验证的题目、隐藏答案、解析、`plan_node_id` 和 `source_card_content_id`。
11. `core_persist_completed`：记录新的 `assessment_id` 和题集序号。
12. `agent_run_succeeded`：记录状态、路径、修复次数、工具调用次数和成本摘要。

### 8.3 后测日志示例

```json
{
  "event_type": "agent_run_succeeded",
  "agent_run_id": "run_posttest_001",
  "agent_role": "node_tutor",
  "run_type": "posttest_generate",
  "logical_session_key": "node:node_123",
  "generation_path": "tavily_recovery",
  "fallback_used": true,
  "source_card_content_id": "content_123",
  "assessment_id": "post_assessment_456",
  "question_count": 6,
  "repair_attempts": 2,
  "validation_errors_before_fallback": ["answer_explanation_missing"],
  "tool_calls": ["tavily_mcp.read"],
  "status": "succeeded"
}
```

## 9. 统一状态与用户可见性

| 内部情况 | AgentRun 内部记录 | 用户侧表现 |
| --- | --- | --- |
| 模型直接生成并通过校验 | `generation_path=model_knowledge` | 正常显示结果 |
| 模型在开放工具的阶段主动调用 Tavily 后通过校验 | `generation_path=model_with_tavily` | 正常显示结果 |
| 最终恢复阶段调用 Tavily 并通过校验 | `generation_path=tavily_recovery`、`fallback_used=true` | 正常显示结果 |
| 某次模型或工具调用异常 | `model_call_failed` 或 `tool_call_failed`，包含错误类别 | 不显示原始错误或模型输出 |
| 最终结果未通过校验 | `validation_failed`，禁止持久化无效结果 | 不返回无效结果，等待基础设施重试或进入内部告警 |

日志事件可以通过内部 AgentRun 事件查询接口供开发和运维使用，但浏览器端只接收状态、已验证的结果摘要和安全的错误文案。

## 10. 日志核对重点

- 前测和路线生成都使用 `agent_role=learning_architect`，并以 `goal_id` 维持同一逻辑会话；
- 节点内容和节点后测都使用 `agent_role=node_tutor`，并以 `plan_node_id` 维持同一逻辑会话；
- Tavily 是否开放由具体工作流阶段决定；路线和内容最终恢复强制调用，前测和后测的开放阶段由模型自主决定；
- 前测和后测最终恢复阶段的实际 Tavily 调用必须以工具事件为准，不把开放工具等同于已经调用；
- Tavily 搜索和资源阅读都记录在同一个 MCP 工具调用链中；
- 正常生成和兜底生成对用户保持相同体验；
- 日志只记录摘要、哈希、版本、来源 ID、耗时和错误类别，不记录敏感原文。
