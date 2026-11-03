# Design

## Context

当前 `plan_generate` 位于 `apps/agent-worker-ts/src/workflows/plan-generate/`，读取 Web 在创建 AgentRun 时冻结的目标、学习画像和已评分前测快照，使用单一 persona 的 ReAct 会话生成 `learning_plan.v1`，然后经内部接口幂等写回路线。Worker 已为学习助手接入 `@langchain/langgraph` 与 PostgreSQL Checkpoint，但学习路线工作流目前没有图级暂停能力。

本变更只把 Human-in-the-Loop 放在学习路线生成的路线规划阶段，不把用户等待引入前测、节点内容或后测；也不公开模型原始思考过程。现有 BullMQ 长任务池、Outbox、模型出网和 Redis 限流仍是执行边界。

## Goals / Non-Goals

**Goals:**

- 在路线最终生成前，基于完整、服务端冻结的结构化输入生成 1–3 个可操作的澄清问题。
- 通过 LangGraph Checkpoint 暂停和恢复同一个 `plan_generate` AgentRun。
- 让用户通过安全 API 选择每题的三个选项之一，第三项支持自定义文本。
- 使人工等待不占用 Worker active 槽位、Redis 模型租约或数据库连接。
- 将答案作为版本化上下文反馈给模型，并继续复用现有路线 schema、工具预算、校验、自纠和幂等回写。
- 支持刷新恢复、重复点击、Worker 重启、答案过期和取消。

**Non-Goals:**

- 不向用户展示 chain-of-thought、内部提示词、工具载荷或完整轨迹。
- 不把 Human-in-the-Loop 扩展到 `assessment_generate`、`card_content_generate` 或 `posttest_generate`。
- 不改变 `learning_plan.v1` 的节点合同、依赖图规则或路线持久化结构。
- 不在等待人工期间保持一个长期运行的 Node Promise、BullMQ Job 或模型 HTTP 请求。
- 不在本变更中替换现有模型 Provider、Redis 限流算法或队列分池策略。

## Decisions

### 1. 在 `plan_generate` 中增加外层 LangGraph 编排，保留现有 ReAct 生成逻辑

图建议拆为以下节点：

```text
load_frozen_input
        ↓
generate_human_review
        ↓
interrupt_for_human
        ↓（resume answers）
merge_human_answers
        ↓
generate_learning_plan
        ↓
validate_learning_plan
        ↓
persist_learning_plan
        ↓
END
```

`generate_learning_plan` 节点复用当前 `runReactAgentSession`，避免同时重写 Tavily、模型工具调用、结构化校验和自纠逻辑。LangGraph 负责跨任务的状态编排、人工中断和恢复；ReAct 负责单次路线生成会话内的工具和模型循环。这样能把改动限制在计划工作流，不影响已有学习助手图。

备选方案是只在现有 `runPlanGenerate` 中写数据库状态并等待下一次 HTTP 请求。这种方式无法安全恢复模型上下文，也会让 Worker 生命周期与用户等待耦合，因此不采用。

### 2. 使用带 PostgreSQL Checkpointer 的 LangGraph 图保存问题批次

`interrupt()` 不是普通的 Promise 等待。编译图时 MUST 显式传入 PostgreSQL Checkpointer，例如 TypeScript 装配形态：

```ts
const checkpointer = PostgresSaver.fromConnString(databaseUrl, { schema: 'agent' });
const graph = new StateGraph(PlanGenerationState)
  .addNode('human_review', humanReviewNode)
  .addNode('generate_plan', generatePlanNode)
  .compile({ checkpointer });
```

正式环境和集成环境都使用 PostgreSQL 持久化实现；MemorySaver 只允许用于不涉及跨进程恢复的单元测试。没有 Checkpointer 时不得启用人工中断功能，启动或功能开关校验必须失败而不是退化成进程内等待。

每个 `plan_generate` AgentRun 使用独立且确定性的图线程标识，例如 `plan_generate:<agent_run_id>`；首次执行、BullMQ 重试、Worker 重启和人工答案恢复都 MUST 使用同一个 `thread_id`。该标识由服务端从已认证的 `agent_run_id` 派生并在恢复时校验，客户端不得提交或覆盖它。Checkpoint 保存：

- 已冻结的输入快照引用或其经过脱敏的结构化副本；
- 当前图版本和问题批次版本；
- 问题与选项快照；
- 已提交答案；
- ReAct 预算、工具调用计数和已完成节点标记。

Checkpoint MUST NOT 保存 API Key、解密后的凭据、完整模型请求头或未经限制的工具返回内容。恢复时由 Worker 根据 AgentRun 绑定的连接 ID 重新通过现有内部端口装配模型连接，继续使用同一模型选择快照。

身份绑定至少包含以下关系：

```text
authenticated owner_id
  ↔ agent_run.owner_id
  ↔ agent_run.goal_id / target_id
  ↔ human_review.agent_run_id
  ↔ derived LangGraph thread_id
```

只校验 `owner_id` 不足以恢复图。服务端还必须确认运行属于目标、人工确认记录属于该运行、`review_id` 属于当前 Checkpoint，且派生出的 `thread_id` 与 Checkpoint 的线程一致；任何一项不一致都必须拒绝恢复，不得尝试从客户端提供的线程 ID 猜测或切换上下文。

本变更采用固定人工确认阶段，而不是让模型在任意 ReAct 轮次动态决定是否暂停。启用 `PLAN_GENERATION_HITL_ENABLED` 的新运行都会进入 `human_review` 节点；模型只负责根据完整结构化上下文生成问题批次，TypeScript 负责 schema 校验，应用代码固定调用 `interrupt()`。模型不得返回 `continue`/`ask_human` 控制信号来绕过或改变该流程。关闭功能开关时才沿用原有无人工确认的直接生成路径。

图在 `interrupt` 返回问题批次后，Worker 捕获可识别的人工暂停结果，原子更新 AgentRun 为 `waiting_for_human` 并结束当前 Job；这不是失败，也不触发 BullMQ 重试。

`thread_id` 是流程恢复主键，不是用户可编辑字段。初次启动和恢复 MUST 使用完全相同的 `thread_id`；更换它会创建新线程，无法回到原中断点。推荐让业务主键决定线程：`plan_generate:<agent_run_id>`。恢复入口统一抽象为 TypeScript 协议：

```ts
type ResumeRequest = {
  threadId: string;
  interruptType: 'plan_generation_human_review';
  reviewId: string;
  questionId: string;
  answer: string | { optionId: string; customText?: string };
  actorId: string;
};

resume(request: ResumeRequest): Promise<ResumeResult>;
```

实际 HTTP 请求不接受客户端传入 `threadId`；服务端从 `agent_run_id` 派生后填充并校验该字段。恢复前必须同时校验 `actorId/owner_id`、`agent_run_id`、`goal_id/target_id`、`review_id`、图版本、问题版本、运行状态和 Checkpoint 线程，不得只依赖 `thread_id`。

### 2.1 节点重放与副作用边界

LangGraph 恢复时会重新执行包含 `interrupt()` 的整个节点，而不是从 `interrupt()` 调用之后的下一行继续。因此 `human_review` 节点在中断前只能做可重复的输入读取、状态准备和问题构造；不得在中断前写业务结果、发送消息、扣费、创建工单或调用不可幂等的外部系统。路线持久化、Outbox 写入和其他副作用放在恢复后的独立节点，并使用现有幂等键。

实现不得使用宽泛的 `try/catch` 吞掉 LangGraph 的中断信号。只捕获经过 LangGraph 识别的暂停结果并转换为 `waiting_for_human`；其他异常按既有失败/重试策略处理。

本变更只设计一个人工中断点和一批问题，因此恢复值使用 `Command({ resume: answer })` 的单值协议。若以后同一超步增加多个并行中断，必须改用按中断 ID 映射的恢复值，例如 `Command({ resume: { [interruptId]: answer } })`；同一节点内多个 `interrupt()` 的调用顺序必须稳定并纳入测试，不能依赖不确定的并行顺序。

`interrupt()` 的 payload、Checkpoint 状态和 `Command({ resume })` 值 MUST 是可序列化的 JSON 数据；不得放入 Error、Socket、数据库连接、模型客户端、函数、Buffer 或循环引用。问题快照和答案只使用字符串、数字、布尔值、数组和普通对象。

### 3. 问题合同使用白名单结构，第三个选项承载自定义文本

建议增加版本化 schema：

```text
HumanReviewQuestionBatch
  schema_version
  review_id
  questions: 1..3

HumanReviewQuestion
  question_id
  prompt
  options: exactly 3

HumanReviewOption
  option_id
  label
  kind: preset | custom_text
  input: { min_length, max_length } | null
```

每题的第三个选项固定为 `kind=custom_text`；前两个选项由模型生成但必须通过文本、长度和重复 ID 校验。服务端在恢复前再次验证问题批次和答案，不接受客户端创建新问题、替换选项或提交任意 Prompt。

初始实现默认每个启用 Human-in-the-Loop 的运行固定产生一批问题，问题数由模型在 1–3 内决定；所有问题都必须有答案后才能恢复。功能开关 `PLAN_GENERATION_HITL_ENABLED` 默认对新图版本开启，关闭时新运行沿用原有直接生成路径。人工确认默认有效期为 2 小时且可配置；过期后运行进入 `expired`，不能自动猜测用户偏好继续生成。

### 4. 通过 AgentRun 公开状态和专用答案接口完成交互

公开 `GET /api/v1/agent-runs/{agent_run_id}` 在 `waiting_for_human` 时返回白名单 `human_review` 快照。新增答案接口建议为：

```text
POST /api/v1/agent-runs/{agent_run_id}/human-review
Idempotency-Key: <uuid>

{
  "review_id": "...",
  "answers": [
    { "question_id": "pace", "option_id": "steady" },
    { "question_id": "format", "option_id": "custom", "custom_text": "希望多安排项目练习" }
  ]
}
```

答案提交事务完成以下动作：校验当前用户、运行所属目标、运行状态、问题/选项版本、`review_id` 与 Checkpoint 线程绑定，写入人工确认记录、把运行从 `waiting_for_human` 转为 `queued`、写入 continuation Outbox 事件。重复幂等键直接返回既有结果；不同答案不得覆盖已经记录的 review。请求体不接收 `thread_id`，服务端从 `agent_run_id` 派生并校验原线程。

AgentRun 的状态流转为：

```text
queued → running → waiting_for_human → queued → running → succeeded
                                      ↘ failed / cancelled / expired
```

`findInFlightRun`、目标删除保护、取消接口、公开类型和前端轮询都必须把 `waiting_for_human` 视为在途状态。

### 5. 人工确认数据采用独立持久化记录并与运行隔离

推荐增加与 `agent_runs` 一对一的人工确认记录，保存 `agent_run_id`、`review_id`、问题快照、答案、版本、状态、过期时间和审计时间。问题和答案不直接覆盖 `input_summary_json`，因为原始输入快照需要保持不可变，且人工答案需要独立幂等和权限查询。

这会涉及数据库迁移；实现前必须按仓库高影响决策流程确认表名、字段和过期策略，并通过 `pnpm db:check` 与迁移验证。若评审选择复用 JSONB，必须保持同样的不可变输入、幂等和拥有者隔离不变量。

### 6. 前端按状态驱动，不等待实时进度事件完成确认

`PlanGenerationAction` 继续轮询 AgentRun 并接收 SSE 进度作为优化通道。轮询到 `waiting_for_human` 后，页面展示问题卡片；每题只能选择一个选项，选择自定义选项时展示受限文本框。提交期间按钮禁用，响应成功后恢复轮询；刷新页面通过目标上的 `latest_plan_run_id` 重新读取同一 review。

页面只展示问题和选项，不展示模型生成过程中的内部思考或工具信息。问题批次恢复、过期和错误使用安全的用户文案。

### 7. 版本与回滚

新运行使用新的 `graphVersion`、`promptVersion` 和输入/人工确认 schema 版本；已经处于 `queued` 或 `running` 的旧版 `plan_generate` 继续走原流程，不在中途切换图。通过配置开关控制新运行是否进入人工确认阶段，关闭后保留原有直接生成路径；关闭开关不得删除已有 Checkpoint 或人工确认记录。

## Risks / Trade-offs

- [人工等待增加路线生成总时延] → 等待期间释放 Worker 和模型许可，页面明确展示等待原因；支持过期、取消和重新发起。
- [模型生成的问题可能没有实际帮助] → 限制为 1–3 个问题，使用结构化 schema、问题版本和前两个预设选项；增加假模型与真实评测样例验证问题质量。
- [新增 `waiting_for_human` 会影响既有 AgentRun 查询和删除保护] → 同步更新领域状态、OpenAPI、Repository、目标读接口、取消逻辑和前端状态测试。
- [Checkpoint 与业务状态或身份绑定不一致] → 人工暂停和答案提交都通过数据库事务记录业务状态；continuation 通过 Outbox 可靠投递；恢复时同时检查 `owner_id`、`goal_id/target_id`、`agent_run_id`、`review_id`、派生 `thread_id`、图版本和运行状态。
- [自定义文本扩大提示注入和敏感数据风险] → 限制长度、按用户输入处理、服务端重新组装上下文，不允许客户端直接注入系统提示词或工具调用。
- [长时间等待的旧 review 占用存储] → 使用默认 2 小时且可配置的过期时间和定期清理；过期只结束运行，不删除审计所需的最小元数据。

## Migration Plan

1. 先增加兼容的 schema、状态枚举、内部类型和只读公开字段，不改变旧运行的处理路径。
2. 执行数据库迁移并验证 `agent_runs` 状态、人工确认记录和 Checkpoint 表结构；运行 `pnpm db:check`。
3. 部署支持 `waiting_for_human` 的 Web/API 和 Worker，再开启新图版本的功能开关。
4. 在假模型、隔离 Redis 和测试数据库中验证暂停、刷新、答案提交、重复点击、Worker 重启、过期和取消。
5. 若出现问题，关闭新运行的功能开关；旧运行按原图完成，新运行可回退到直接生成路径。不得删除已有 Checkpoint 或人工答案记录。

## Open Questions

无。初始实现采用固定人工确认阶段、2 小时可配置过期时间、每个运行一批 1–3 个问题、所有问题必须回答、`PLAN_GENERATION_HITL_ENABLED` 默认开启的方案；模型不决定是否中断，只生成问题内容。评审若调整这些参数，只需同步规格中的边界和对应任务，不改变 LangGraph Checkpoint 与 Outbox 恢复架构。
