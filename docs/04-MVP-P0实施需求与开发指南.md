# LearnCraft MVP P0 实施需求与开发指南

> 版本：v0.2（待评审）
> 日期：2026-08-01
> 配套文档：[技术栈选型](./01-技术栈选型.md) · [DDD 项目目录](./02-DDD项目目录.md) · [MVP PRD](./03-MVP-PRD.md)

## 1. 文档目的、P0 边界与已锁定决策

本文把产品 PRD 进一步落成一个人可以按顺序实现、联调和验收的 **P0 开发基线**。它不替代前三份文档：

- `01` 说明为什么选择 A 架构；
- `02` 说明领域边界和目录依赖；
- `03` 说明产品目标和完整 MVP 范围；
- **本文**定义 P0 具体要做什么、怎样建表、接口长什么样，以及从零开始的实现顺序。

### 1.1 P0 的一句话目标

一位用户能够注册登录，填写 Python 学习目标并完成前测，获得一条包含“概念 → 语法 → 实战 → 调试”的学习路线；点击卡片取得带来源的学习内容，并通过独立 CodeRun 接口在线运行受限 Python 代码；完成整条路线后，再通过后测获得掌握、复习或提高下一路线难度的建议。

### 1.2 P0 产品与技术边界

| 项目 | P0 固定范围 | 原因 |
| --- | --- | --- |
| 试点主题 | 仅 `python-311-basics`，中文桌面端 | 先验证闭环，不把内容、评测和 Runner 复杂度乘以多语言。 |
| 学习目标 | 每个目标一条当前激活路线；路线 6–12 个节点 | 足够展示个性化和四阶段，避免路线编辑器。 |
| 前测与路线后测 | 前测由用户选择 10–20 题（默认推荐 12 题），后测由用户选择 5–10 题（推荐 5–8 题）；均为单选题 | 提交后可立即确定性评分；前测提供“正常/困难”卡片且按题序逐步提高难度。 |
| 知识来源 | 内置、人工审核的官方文档/视频链接和种子文档 | P0 不允许用户上传 PDF、任意 URL 抓取或 MinerU 解析。 |
| 检索 | PostgreSQL FTS + pgvector 余弦精确检索；返回可追溯引用 | 小规模内容先获得确定性和易维护性；压测后才加 HNSW。 |
| 在线代码 | Python 3.11、预置依赖、无网络、限时限资源；实战/调试节点先展示 AI 生成且 Runner 已验证的 Demo | 代码执行是高风险能力，不能把宿主机或任意依赖暴露给用户。 |
| 模型 | 用户自带 OpenAI-compatible 生成连接 + 一个固定 embedding Profile；Worker 按任务解析已选连接 | 不部署 vLLM/Ollama；用户承担生成 Provider 费用，平台免费提供学习流程、检索与运行能力。P0 允许任意 Base URL，SSRF 防护列为 P1。 |
| 异步任务 | 规划、内容/Demo 生成和自动出题通过 `AgentRun` 异步执行；单选题评分同步完成 | 模型调用有延迟和失败，需要可重试、可观察、可恢复；确定性评分不需要排队。 |

### 1.3 P0 已作出的实现决策

1. **架构：**Next.js App Router 负责 UI、BFF、认证与核心学习领域；Python FastAPI + LangGraph 仅负责 Agent 编排、模型调用、检索和受控工具。Python 不复制学习路线、题目等业务聚合。
2. **认证：**P0 使用“邮箱 + 密码 + 数据库不透明 Session + HttpOnly Cookie”。密码用 Argon2id 哈希；浏览器不接收 JWT。这样本地开发不依赖 OAuth 或邮件供应商，也不会把长期令牌暴露给前端。OAuth、Magic Link、找回密码和移动端 Token 放 P1。
3. **迁移所有权：**`db/migrations/` 中的 Drizzle 迁移是 P0 唯一建表入口。`apps/agent-worker/alembic/` 保留说明文件，但 **P0 不执行 Alembic**，否则会出现两个迁移工具竞争同一数据库的问题。
4. **用户模型连接：**`ModelGateway` 是 `agent-worker` 内的应用服务，不是 Docker 容器。用户可保存 OpenAI-compatible Base URL、API Key 和模型名；Key 由 Web 以 AES-256-GCM 加密持久化，浏览器只可写入/覆盖，Outbox、日志和 AgentRun 仅记录连接 ID/模型名。`CREDENTIAL_ENCRYPTION_KEY` 只进入 Web 与 Worker 的 Secret/环境变量。
5. **向量索引：**P0 先不建 ANN 索引。固定 embedding Profile、内容量和检索评测集后，只有在检索 p95 或数据量达到阈值时，才用 HNSW 作为首个 ANN 方案；不引入独立向量数据库。
6. **代码 Runner：**Docker Compose 是本地编排工具，不是用户不可信代码的安全边界。上线前必须验证一次性沙箱的断网、非 root、只读根文件系统、资源限制和逃逸测试；未达到标准时，P0 关闭“运行”按钮而不是冒险上线。

### 1.4 P0 明确不做

- 社区、社群、评论、关注、排行榜、成就、全局学习进度条、学习报告；
- 多课程、多编程语言、任意文件/网页导入、视频转写、自动抓取互联网；
- 本地模型、vLLM、Ollama、自动的跨 Provider 费用优化或平台代付生成费用；
- 多租户组织、付费订阅、管理员后台、人工教师批改；
- 多人协作、通用聊天助手、长期记忆、自动向外部系统发布；
- 任意 `pip install`、网络访问、持久磁盘、GPU 或长任务代码执行。

---

## 2. P0 需求清单

### 2.1 用户认证与资源隔离

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-AUTH-001 | 用户可用邮箱、昵称、密码注册。 | 合法输入返回 `201` 且不设置 Session Cookie；重复邮箱返回 `409 EMAIL_ALREADY_EXISTS`；数据库仅保存 Argon2id 哈希。 |
| P0-AUTH-002 | 用户可用邮箱和密码登录。 | 正确凭据返回 `200` 并设置 `HttpOnly`、`Secure`（生产）、`SameSite=Lax` Session Cookie；响应体不含密码、哈希或原始 session token。 |
| P0-AUTH-003 | 用户可退出和使当前 Session 失效。 | 退出后 Cookie 被清除，服务器 Session 标记为撤销；再次访问私有 API 返回 `401`。 |
| P0-AUTH-004 | 所有用户私有资源按 `owner_id` 鉴权。 | 用户 A 使用用户 B 的目标、路线、题目、代码运行或 AgentRun ID 请求时，统一返回 `404`（不泄露资源存在）。 |
| P0-AUTH-005 | 认证入口具备基础防暴力破解能力。 | 注册/登录按 IP 与账号标识限流；连续失败有统一错误文案；日志不记录密码。 |
| P0-AUTH-006 | Session 采用受限滑动续期。 | 闲置满 3 天失效；从创建起最长 15 天；仅在剩余不足 24 小时且距上次续期超过 12 小时时，续期并写库。 |

**暂时需要做：**邮箱格式和密码强度校验（12–128 字符）、Argon2id 哈希、数据库 Session、CSRF 同源保护、服务端 owner 校验、基于 Redis 的登录/注册限流、Session 定期清理。

**暂时不需要做：**邮箱验证、忘记密码、OAuth、Magic Link、MFA、设备管理、管理员/角色体系、面向移动 App 的 Bearer Token。`accounts.password` 不是推荐表设计：P0 将密码哈希放在 `users.password_hash`；未来若接 OAuth，`oauth_accounts` 专门保存第三方账号绑定。

### 2.2 学习者画像与学习目标

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-PROFILE-001 | 首次进入时收集学习水平、每周可投入时间、内容偏好和设备信息。 | 必填项缺失不能进入建目标步骤；刷新后资料仍存在。 |
| P0-PROFILE-002 | 用户可创建一个 Python 3.11 基础学习目标。 | 目标包含主题、自然语言说明、期望结果、截止日期（可选）和每周时间（可选）；不支持的 `subject_key` 返回 `422`。 |
| P0-PROFILE-003 | 用户可查看和修改自己的画像与草稿目标。 | 修改只影响本人数据；修改后生成路线前会使用最新画像版本。 |
| P0-PROFILE-004 | 已启动规划的目标显示明确状态。 | 状态至少可见：`draft`、`assessment_pending`、`planning`、`active`、`failed`；页面不会无提示地一直加载。 |

**暂时需要做：**单主题白名单、表单 Zod 校验、目标与画像版本、目标状态机、空状态和失败重试入口。

**暂时不需要做：**用户自定义课程市场、技能树编辑、学习时间日历、多个并行主题推荐、企业/班级画像。

### 2.3 前测与能力判定

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-ASSESS-001 | 为目标生成或选择一套前测。 | 用户可选择 10–20 题，默认推荐 12 题；只包含单选题；模型生成失败时可降级到受控题库。 |
| P0-ASSESS-002 | 用户可以保存作答并提交前测。 | 刷新不丢答案；重复点击提交不创建两条 Attempt；提交后的答案不可直接修改。 |
| P0-ASSESS-003 | 系统自动评分并给出薄弱点标签。 | 服务端按隐藏答案确定性评分并返回结构化分数、反馈和薄弱点标签；正确答案不通过公开 API 返回。 |
| P0-ASSESS-004 | 前测结果驱动后续路线生成。 | 评分完成后目标状态进入 `planning`，创建一条可追踪的 `plan_generate` AgentRun。 |
| P0-ASSESS-005 | 异常状态可恢复。 | 题目生成/评分失败显示失败原因类别与“重试”入口，不产生重复费用或重复题目。 |

**暂时需要做：**10–20 题单选前测、`normal`/`hard` 难度卡片、按题序逐步提高难度、确定性评分、受控题库兜底、答题幂等与隐藏答案。

**暂时不需要做：**长篇作文/开放项目报告的主观阅卷、人工批改、限时监考、题库运营后台、跨目标能力雷达图。

### 2.4 学习路线与动态调整

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-PLAN-001 | 根据画像、目标和前测生成路线。 | 路线含 6–12 个节点，覆盖 `concept`、`syntax`、`practice`、`debug` 四阶段。 |
| P0-PLAN-002 | 每个节点有可展示的学习信息。 | 节点至少含标题、目标、难度、预计分钟、前置节点、完成标准、安排理由和状态。 |
| P0-PLAN-003 | 路线依赖关系合法。 | 保存前校验节点数、阶段覆盖、前置无环和时长范围；不合法结果不能写入激活路线。 |
| P0-PLAN-004 | 用户能查看路线并打开当前可学节点。 | 路线页能区分 `locked`、`available`、`in_progress`、`completed`、`needs_review`；首个可学节点可直接进入。 |
| P0-PLAN-005 | 后测/代码结果产生显式建议。 | 整条路线完成后的后测 ≥80% 标记为掌握；50–79% 标记复习建议；<50% 或连续代码失败，为下一次学习建议补强主题；所有建议写入审计事件。 |
| P0-PLAN-006 | 高分建议有边界。 | 后测 100% 且相关代码通过时，只能建议下一条路线选用“困难”难度；不得跳过或改写当前路线节点，页面展示理由。 |

**暂时需要做：**异步路线生成、DAG 校验、路线版本、简单可解释规则、节点状态展示和失败重试。

**暂时不需要做：**拖拽编辑路线、用户手工改依赖、复杂推荐模型、跨课程知识图谱、完整进度报表。

### 2.5 卡片内容、受控资料与检索

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-CONTENT-001 | 点击可学节点后按需生成内容卡。 | 内容至少有学习目标、核心解释、示例、练习、提示和资料引用；`practice/debug` 节点额外带经 Runner 验证的可运行 Demo、调用顺序和注释结果。 |
| P0-CONTENT-002 | 内容只使用获准来源或显式标记模型推断。 | 每个引用返回来源名称、URL、文档/页码或定位；找不到来源时不伪造引用。 |
| P0-CONTENT-003 | 检索先做权限/标签过滤，再做 FTS 和向量召回。 | 检索日志保留 `source/document/chunk` 标识与 profile 版本；UI 不直接查询 pgvector。 |
| P0-CONTENT-004 | 内容生成结果可版本化和重试。 | 同一节点重新生成创建新 `card_contents.version`，历史内容不被覆盖；幂等重放不重复创建。 |
| P0-CONTENT-005 | P0 内容目录可被种子脚本初始化。 | 新环境执行 seed 后，至少有一组 Python 基础资料、分块和 embedding，可完成一次真实检索。 |

**暂时需要做：**种子来源、对象存储 URI 元数据、分块、固定 embedding、FTS、精确向量检索、引用校验、卡片内容 schema，以及实战/调试 Demo 的结构化合同和发布前验证。

**暂时不需要做：**用户上传、任意 URL 抓取、PDF/OCR/MinerU、视频转写、全文版权库、Milvus 迁移、多 embedding 版本共存。检索实现必须只依赖 `VectorStore` 抽象，P0 由 pgvector 适配器承载。

#### 实战 / 调试节点的可运行 Demo 合同

`phase = practice` 与 `phase = debug` 的 `card_contents.public_content_json` 必须包含下列字段；概念、语法节点可只提供普通示例与练习。

```json
{
  "runnable_demo": {
    "language": "python-3.11",
    "source_code": "def greet(name):\n    return f'Hello, {name}!'\n\nprint(greet('LearnCraft'))\n",
    "stdin": "",
    "expected_stdout": "Hello, LearnCraft!\n",
    "validated_code_run_id": "uuid",
    "validated_at": "2026-07-18T12:00:00Z"
  },
  "call_sequence": [
    { "step": 1, "symbol": "__main__", "action": "执行 print(...)" },
    { "step": 2, "symbol": "greet", "action": "接收 name 并返回格式化字符串" }
  ],
  "annotated_result": [
    { "step": 1, "code_reference": "print(greet('LearnCraft'))", "explanation": "入口调用 greet。" },
    { "step": 2, "code_reference": "return f'Hello, {name}!'", "explanation": "函数返回字符串，随后由 print 输出。", "observed_stdout": "Hello, LearnCraft!" }
  ]
}
```

`debug` 节点还应提供一个**受控故障版本**（故障位置、可复现症状、诊断提示和修复后代码）。最终展示的 `runnable_demo` 必须是修复后、在 Runner 中验证成功的版本；故障版本只能在同一个隔离环境中运行，不能用未验证的 AI 代码冒充 Demo。

### 2.6 在线代码实践

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-RUN-001 | 实战/调试节点由 AI 生成可运行 Demo。 | AI 输出 Python 3.11 源码、输入、期望输出、调用顺序与逐步注释结果；发布给用户前必须在受限 Runner 成功执行。 |
| P0-RUN-002 | CodeRun 作为独立 HTTP 接口异步执行受限代码。 | 在 `goal_id + plan_node_id` 卡片上下文内创建并返回 `queued/running/succeeded/failed/timeout/rejected`；不依赖 LangGraph 工作流；重复请求依赖 Idempotency-Key 不产生第二次执行。 |
| P0-RUN-003 | 运行环境默认隔离。 | 执行进程为非 root、无网络、无宿主机挂载、临时目录、CPU/内存/进程数/输出大小/墙钟时间均有限额。 |
| P0-RUN-004 | 用户可见并理解运行结果。 | 页面展示 Demo/用户代码的 stdout、stderr、退出码、测试摘要与耗时，并将实际运行结果映射到调用顺序和逐步注释；不泄露主机路径、环境变量、Token 或内部异常栈。 |

**暂时需要做：**Python 3.11 固定镜像、AI Demo 的生成后 Runner 验证、调用顺序/注释结果 schema、受限 API、运行状态查询、基础隐藏测试、超时和输出截断、恶意样例测试。

**暂时不需要做：**任意语言、包安装、网络请求、文件持久化、多人共享运行环境、GPU、长任务、Notebook。

### 2.7 路线后测、完成规则与适应性

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-POST-001 | 整条路线完成后生成后测。 | 用户可选择 5–10 题，推荐 5–8 题；只包含单选题，且 `plan_id` 必填、`plan_node_id` 为空；无法生成时走受控模板。 |
| P0-POST-002 | 提交后获得评分与解释。 | 服务端确定性评分并返回总分、逐题反馈和薄弱点；隐藏答案不外泄。 |
| P0-POST-003 | 路线完成条件明确。 | 所有节点完成后可发起后测；后测 ≥80% 标记为掌握；有代码任务时其 CodeRun 必须成功；不满足时允许复习和重测，不丢历史结果。 |
| P0-POST-004 | 后续建议可审计。 | 每一次掌握、复习或提高下一路线难度的建议都记录触发证据、策略版本和结果。 |

**暂时需要做：**前测与后测共用的单选题和确定性评分合同、自动出题/模板兜底、题量边界、完成条件、规则驱动建议、用户可见理由。

**暂时不需要做：**完整学习报告、徽章/积分、同伴对比、复杂知识追踪算法、教师审批。

### 2.8 Agent、模型供应商与可观测性

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-AGENT-001 | 每项模型长任务有 AgentRun。 | 前测/后测出题、路线生成、内容/Demo 生成与验证都返回 `agent_run_id` 与状态；确定性评分和 CodeRun 状态查询不创建 AgentRun。 |
| P0-AGENT-002 | ModelGateway 使用用户选择的 OpenAI-compatible 连接。 | 用户可在模型设置保存 Base URL/API Key/模型名，账户默认可被目标、前测/后测出题和 AI Demo 生成覆盖；Key 加密保存且不进入响应、日志、Outbox 或 AgentRun。运行记录连接 ID、模型名、超时、重试、token 与费用估算。 |
| P0-AGENT-003 | 模型输出通过结构化校验和业务校验。 | Pydantic/JSON Schema 失败可有限次重试，之后回退模板或失败；无效路线/题目/AI 评分/Demo/引用不得写库或触发路线调整。 |
| P0-AGENT-004 | Worker 故障可定位和恢复。 | `trace_id` 可贯穿 Web、Outbox、Worker、模型调用和 Runner；失败有错误类别、可重试标识和安全的用户文案。 |

**暂时需要做：**OpenAI-compatible Adapter、用户模型连接设置、AES-256-GCM 凭据加密、账户默认和任务级覆盖、Fake Adapter、超时/预算/重试、结构化输出、AgentRun 事件、健康检查。

**暂时不需要做：**自动跨 Provider 智能路由、微调、模型网关独立服务、LangSmith 强依赖、自托管推理，以及 P1 的自定义 Base URL SSRF 受控出网层。

---

## 3. 数据库设计

### 3.1 设计原则

| 原则 | 说明 |
| --- | --- |
| 原生类型优先 | ID 用 PostgreSQL `uuid`，时间用 `timestamptz`，可演进的结构才用 `jsonb`；不以 `VARCHAR(36)` 模拟 UUID。 |
| 单一事实源 | `public` 中的用户、目标、路线、题目、内容、代码运行等由 Next.js Core 领域服务写入；Python Worker 不绕过 Core API 修改这些表。 |
| Agent 独立基础设施 | `agent` schema 仅保存 AgentRun 和运行事件；它记录“如何执行”，不定义“何为合格路线”。 |
| 迁移单一所有者 | Drizzle 负责所有 schema 迁移，包括 `agent` schema 的 DDL；P0 不同时运行 Alembic。 |
| 所有权默认显式 | 每个用户私有聚合保留 `owner_id`，每个查询都按 `id + owner_id` 过滤；P0 服务层执行 ACL，P2 再评估 RLS。 |
| 状态不藏在 JSONB | 路线、节点、测验、运行、Agent 的关键状态使用 `varchar + CHECK`；JSONB 只存模型元数据、结构化内容或资源用量。 |
| 版本不可覆盖 | 路线、卡片内容、题目和 Attempt 都带版本/快照；重新生成和重试不能覆盖历史结果。 |
| 幂等写入 | 所有会创建费用、任务或执行的写 API 接收 `Idempotency-Key`，并保存请求哈希与原始响应。 |
| Embedding 固定 | P0 一个数据库只接受一个固定 embedding Profile/维度。切换模型要走新迁移和完整重嵌入，不能静默混用向量维度。 |
| 敏感数据最小化 | 用户 Provider API Key 仅以 AES-256-GCM 密文、IV、认证标签和密钥版本存储；不记录明文密码、原始 session token、隐藏答案、完整 prompt 或未脱敏的模型响应。 |
| 自动更新时间 | `updated_at DEFAULT now()` 不会自动更新；所有含 `updated_at` 的表通过数据库 trigger 统一维护。 |

### 3.2 Schema、表数量与模型归属

P0 共 **23 张 LearnCraft 应用/基础设施表**：`public` schema 21 张，`agent` schema 2 张。LangGraph PostgreSQL checkpointer 的官方表不算入这 23 张；它由锁定版本的 `langgraph-checkpoint-postgres` 官方迁移创建，不能手写一个“类似的” ORM 表替代。

| Schema | 表 | 写入所有者 | ORM/Schema 文件 | 用途 |
| --- | --- | --- | --- | --- |
| public | `users`、`auth_sessions` | Web Identity | `db/schema/identity.ts` | 邮箱密码账号和数据库 Session。 |
| public | `user_model_connections` | Web Model Connection | `db/schema/model-connection.ts` | 用户自带 OpenAI-compatible Base URL、默认模型及 AES-256-GCM 加密凭据。 |
| public | `learner_profiles` | Web Profile | `db/schema/profile.ts` | 学习者画像。 |
| public | `learning_goals`、`learning_plans`、`plan_nodes`、`plan_node_prerequisites`、`adaptation_events` | Web Planning | `db/schema/planning.ts` | 目标、路线、节点、依赖和调整审计。 |
| public | `assessments`、`assessment_items`、`assessment_attempts`、`assessment_answers` | Web Assessment | `db/schema/assessment.ts` | 前测、路线后测、答案与评分快照。 |
| public | `content_sources`、`content_documents`、`content_chunks`、`card_contents`、`card_content_references` | Web Content | `db/schema/content.ts` | 受控资料、FTS/向量、卡片内容/引用，以及实战/调试 Demo 合同与验证摘要。 |
| public | `code_runs` | Web Practice | `db/schema/practice.ts` | 受限代码执行任务和结果。 |
| public | `outbox_events`、`idempotency_keys` | Web Shared Infrastructure | `db/schema/integration.ts` | 可靠投递和 HTTP 写操作幂等。 |
| agent | `agent_runs`、`agent_run_events` | Python Agent Worker | `infrastructure/persistence/models/` | 编排状态、可重放运行事件和模型审计。 |

> **数据库基类澄清：**Drizzle 是 TypeScript 查询/映射工具，不使用 Python 那种 `DeclarativeBase` 继承树；公共业务表用 Drizzle schema + SQL migration 定义。Python 的 SQLAlchemy `Base` 只映射 `agent_runs` 和 `agent_run_events`，不能再创建一套 `UserModel`、`LearningPlanModel` 与 Next.js 竞争。

### 3.3 表关系图

```mermaid
erDiagram
    USERS ||--|| LEARNER_PROFILES : has
    USERS ||--o{ AUTH_SESSIONS : opens
    USERS ||--o{ LEARNING_GOALS : owns
    USERS ||--o{ USER_MODEL_CONNECTIONS : configures
    USER_MODEL_CONNECTIONS ||--o{ LEARNING_GOALS : overrides
    LEARNING_GOALS ||--o{ LEARNING_PLANS : versions
    LEARNING_PLANS ||--o{ PLAN_NODES : contains
    PLAN_NODES ||--o{ PLAN_NODE_PREREQUISITES : depends_on
    LEARNING_GOALS ||--o{ ASSESSMENTS : has
    ASSESSMENTS ||--o{ ASSESSMENT_ITEMS : contains
    ASSESSMENTS ||--o{ ASSESSMENT_ATTEMPTS : receives
    ASSESSMENT_ATTEMPTS ||--o{ ASSESSMENT_ANSWERS : contains
    PLAN_NODES ||--o{ CARD_CONTENTS : renders
    CARD_CONTENTS ||--o{ CARD_CONTENT_REFERENCES : cites
    CONTENT_SOURCES ||--o{ CONTENT_DOCUMENTS : provides
    CONTENT_DOCUMENTS ||--o{ CONTENT_CHUNKS : splits_into
    CONTENT_CHUNKS ||--o{ CARD_CONTENT_REFERENCES : supports
    PLAN_NODES ||--o{ CODE_RUNS : executes
    LEARNING_PLANS ||--o{ ADAPTATION_EVENTS : adjusts
    USERS ||--o{ AGENT_RUNS : owns
    USER_MODEL_CONNECTIONS ||--o{ AGENT_RUNS : selected_for
    AGENT_RUNS ||--o{ AGENT_RUN_EVENTS : emits
```

### 3.4 初始化约定

下面 DDL 是 P0 的迁移蓝图。当前空库基线已由 Drizzle 生成 `apps/web/src/lib/db/migrations/0000_initial_p0_schema.sql`，并在该文件中补充扩展、`agent` schema 与 trigger 的 raw SQL；不要把整段 SQL 在生产库手工粘贴运行。

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS agent;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
```

`agent-worker` 连接字符串必须设置 `search_path=agent,public`，并使用权限受限的数据库角色；它只能写 `agent.*` 和共享基础设施所需的 Outbox 状态，核心业务结果经内部 Core API 写入。

### 3.5 全部 P0 建表 DDL（第一部分：身份、画像、规划）

```sql
CREATE TABLE public.users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           citext NOT NULL UNIQUE,
    display_name    varchar(120) NOT NULL,
    password_hash   text NOT NULL, -- Argon2id encoded hash；绝不保存明文
    status          varchar(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'pending_deletion')),
    last_login_at   timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 用户生成模型连接。encrypted_api_key、api_key_iv、api_key_auth_tag 均为 Base64 文本；
-- 明文 API Key 只在创建/更新请求到达 Web 后短暂存在，绝不写入数据库、日志或异步消息。
CREATE TABLE public.user_model_connections (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id               uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    display_name           varchar(80) NOT NULL,
    protocol               varchar(40) NOT NULL DEFAULT 'openai_compatible'
                           CHECK (protocol = 'openai_compatible'),
    base_url               text NOT NULL CHECK (length(btrim(base_url)) > 0),
    default_model_id       varchar(255) NOT NULL CHECK (length(btrim(default_model_id)) > 0),
    encrypted_api_key      text NOT NULL,
    api_key_iv             text NOT NULL,
    api_key_auth_tag       text NOT NULL,
    encryption_key_version varchar(50) NOT NULL,
    status                 varchar(20) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'invalid', 'revoked')),
    is_default             boolean NOT NULL DEFAULT false,
    last_verified_at       timestamptz,
    last_error_code        varchar(100),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_model_connections_owner_name
        UNIQUE (owner_id, display_name)
);

CREATE UNIQUE INDEX uq_user_model_connections_owner_default
    ON public.user_model_connections(owner_id)
    WHERE is_default;

CREATE INDEX idx_user_model_connections_owner_status
    ON public.user_model_connections(owner_id, status, updated_at DESC);

CREATE TABLE public.auth_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    token_hash      char(64) NOT NULL UNIQUE, -- SHA-256(raw opaque token)
    expires_at      timestamptz NOT NULL, -- 闲置有效期；最大值受 created_at + 15 天约束
    last_seen_at    timestamptz NOT NULL DEFAULT now(), -- 最近一次被允许续期的时间
    revoked_at      timestamptz,
    ip_hash         char(64),
    user_agent      varchar(500),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_auth_sessions_expiry CHECK (expires_at > created_at)
);

CREATE INDEX idx_auth_sessions_user_active
    ON public.auth_sessions(user_id, expires_at DESC)
    WHERE revoked_at IS NULL;

CREATE INDEX idx_auth_sessions_cleanup
    ON public.auth_sessions(expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE public.learner_profiles (
    user_id             uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    current_level       varchar(20) NOT NULL
                        CHECK (current_level IN ('beginner', 'intermediate', 'advanced')),
    primary_language    varchar(20) NOT NULL DEFAULT 'zh-CN',
    weekly_minutes      integer NOT NULL CHECK (weekly_minutes BETWEEN 30 AND 10080),
    operating_system    varchar(30),
    background_summary  text,
    preferences_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
    profile_version     integer NOT NULL DEFAULT 1 CHECK (profile_version >= 1),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.learning_goals (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id                uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    subject_key             varchar(80) NOT NULL
                            CHECK (subject_key IN ('python-311-basics')),
    title                   varchar(200) NOT NULL,
    description             text NOT NULL,
    desired_outcome         text NOT NULL,
    target_date             date,
    weekly_minutes_override integer CHECK (
                              weekly_minutes_override IS NULL
                              OR weekly_minutes_override BETWEEN 30 AND 10080
                            ),
    model_connection_id     uuid REFERENCES public.user_model_connections(id) ON DELETE SET NULL,
    profile_version         integer NOT NULL CHECK (profile_version >= 1),
    status                  varchar(30) NOT NULL DEFAULT 'draft'
                            CHECK (status IN (
                              'draft', 'assessment_pending', 'assessment_in_progress',
                              'planning', 'active', 'completed', 'archived', 'failed'
                            )),
    metadata_json           jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_learning_goals_owner_status
    ON public.learning_goals(owner_id, status, updated_at DESC);

CREATE TABLE public.learning_plans (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    goal_id               uuid NOT NULL REFERENCES public.learning_goals(id) ON DELETE CASCADE,
    version               integer NOT NULL CHECK (version >= 1),
    title                 varchar(255) NOT NULL,
    summary               text,
    status                varchar(30) NOT NULL DEFAULT 'generating'
                          CHECK (status IN ('generating', 'active', 'superseded', 'failed', 'archived')),
    schema_version        varchar(50) NOT NULL,
    generation_metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
    generated_at          timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_learning_plans_goal_version UNIQUE (goal_id, version)
);

CREATE UNIQUE INDEX uq_learning_plans_one_active_goal
    ON public.learning_plans(goal_id)
    WHERE status = 'active';

CREATE INDEX idx_learning_plans_owner_goal
    ON public.learning_plans(owner_id, goal_id, version DESC);

CREATE TABLE public.plan_nodes (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    plan_id               uuid NOT NULL REFERENCES public.learning_plans(id) ON DELETE CASCADE,
    parent_node_id        uuid REFERENCES public.plan_nodes(id) ON DELETE SET NULL,
    node_key              varchar(100) NOT NULL,
    ordinal               integer NOT NULL CHECK (ordinal >= 1),
    phase                 varchar(20) NOT NULL
                          CHECK (phase IN ('concept', 'syntax', 'practice', 'debug')),
    node_kind             varchar(20) NOT NULL DEFAULT 'core'
                          CHECK (node_kind IN ('core', 'reinforcement', 'advanced')),
    title                 varchar(255) NOT NULL,
    learning_objective    text NOT NULL,
    rationale             text,
    difficulty            smallint NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
    estimated_minutes     integer NOT NULL CHECK (estimated_minutes BETWEEN 5 AND 1440),
    completion_criteria   jsonb NOT NULL DEFAULT '{}'::jsonb,
    status                varchar(30) NOT NULL DEFAULT 'locked'
                          CHECK (status IN (
                            'locked', 'available', 'in_progress',
                            'completed', 'needs_review', 'skipped'
                          )),
    content_status        varchar(30) NOT NULL DEFAULT 'not_requested'
                          CHECK (content_status IN ('not_requested', 'generating', 'ready', 'failed')),
    inserted_reason       text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_plan_nodes_key UNIQUE (plan_id, node_key),
    CONSTRAINT uq_plan_nodes_ordinal UNIQUE (plan_id, ordinal)
);

CREATE INDEX idx_plan_nodes_owner_status
    ON public.plan_nodes(owner_id, status, updated_at DESC);

CREATE TABLE public.plan_node_prerequisites (
    node_id               uuid NOT NULL REFERENCES public.plan_nodes(id) ON DELETE CASCADE,
    prerequisite_node_id  uuid NOT NULL REFERENCES public.plan_nodes(id) ON DELETE CASCADE,
    created_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (node_id, prerequisite_node_id),
    CONSTRAINT ck_plan_node_not_self_prerequisite CHECK (node_id <> prerequisite_node_id)
);

CREATE INDEX idx_plan_node_prerequisites_prerequisite
    ON public.plan_node_prerequisites(prerequisite_node_id);

CREATE TABLE public.adaptation_events (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    plan_id               uuid NOT NULL REFERENCES public.learning_plans(id) ON DELETE CASCADE,
    trigger_node_id       uuid NOT NULL REFERENCES public.plan_nodes(id) ON DELETE CASCADE,
    event_type            varchar(30) NOT NULL
                          CHECK (event_type IN (
                            'unlock', 'recommend_review', 'insert_reinforcement',
                            'accelerate', 'skip'
                          )),
    policy_version        varchar(50) NOT NULL,
    evidence_json         jsonb NOT NULL DEFAULT '{}'::jsonb,
    result_json           jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_adaptation_events_plan_created
    ON public.adaptation_events(plan_id, created_at DESC);
```

### 3.6 全部 P0 建表 DDL（第二部分：测验、内容与 pgvector）

```sql
CREATE TABLE public.assessments (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    goal_id               uuid NOT NULL REFERENCES public.learning_goals(id) ON DELETE CASCADE,
    plan_id               uuid REFERENCES public.learning_plans(id) ON DELETE CASCADE,
    plan_node_id          uuid REFERENCES public.plan_nodes(id) ON DELETE CASCADE,
    kind                  varchar(30) NOT NULL
                          CHECK (kind IN ('diagnostic', 'post_test', 'card_quiz')),
    requested_question_count integer,
    difficulty            varchar(20) NOT NULL DEFAULT 'normal'
                          CHECK (difficulty IN ('normal', 'hard')),
    version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    status                varchar(30) NOT NULL DEFAULT 'generating'
                          CHECK (status IN (
                            'generating', 'ready', 'in_progress', 'submitted', 'grading',
                            'graded', 'failed', 'archived'
                          )),
    schema_version        varchar(50) NOT NULL,
    generation_metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
    total_score           numeric(8,2),
    max_score             numeric(8,2),
    score_percent         numeric(5,2) CHECK (
                          score_percent IS NULL OR score_percent BETWEEN 0 AND 100
                        ),
    mastery_summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_assessment_scope CHECK (
      (kind = 'diagnostic' AND plan_id IS NULL AND plan_node_id IS NULL)
      OR
      (kind = 'post_test' AND plan_id IS NOT NULL AND plan_node_id IS NULL)
      OR
      (kind = 'card_quiz' AND plan_node_id IS NOT NULL)
    ),
    CONSTRAINT ck_assessments_question_count CHECK (
      (kind = 'diagnostic' AND requested_question_count BETWEEN 10 AND 20)
      OR (kind = 'post_test' AND requested_question_count BETWEEN 5 AND 10)
      OR (kind = 'card_quiz' AND requested_question_count IS NULL)
    )
);

CREATE INDEX idx_assessments_owner_goal_kind
    ON public.assessments(owner_id, goal_id, kind, created_at DESC);

CREATE TABLE public.assessment_items (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id         uuid NOT NULL REFERENCES public.assessments(id) ON DELETE CASCADE,
    ordinal               integer NOT NULL CHECK (ordinal >= 1),
    item_type             varchar(30) NOT NULL
                          CHECK (item_type = 'single_choice'),
    prompt                text NOT NULL,
    options_json          jsonb NOT NULL DEFAULT '[]'::jsonb,
    answer_key_json       jsonb NOT NULL, -- 单选题正确选项；只允许评分服务端读取
    grading_mode          varchar(30) NOT NULL
                          CHECK (grading_mode = 'deterministic'),
    rubric_json           jsonb NOT NULL DEFAULT '{}'::jsonb, -- 历史兼容列；P0 单选题不写入、不读取 rubric
    explanation           text NOT NULL,
    skill_tags            text[] NOT NULL DEFAULT '{}',
    max_score             numeric(8,2) NOT NULL CHECK (max_score > 0),
    schema_version        varchar(50) NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_assessment_items_ordinal UNIQUE (assessment_id, ordinal),
    CONSTRAINT ck_assessment_item_grading_mode CHECK (
      item_type = 'single_choice'
      AND grading_mode = 'deterministic'
      AND jsonb_typeof(options_json) = 'array'
      AND jsonb_array_length(options_json) >= 2
    )
);

CREATE TABLE public.assessment_attempts (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    assessment_id         uuid NOT NULL REFERENCES public.assessments(id) ON DELETE CASCADE,
    attempt_no            integer NOT NULL CHECK (attempt_no >= 1),
    status                varchar(20) NOT NULL DEFAULT 'in_progress'
                          CHECK (status IN ('in_progress', 'submitted', 'grading', 'graded', 'invalid', 'grading_failed')),
    total_score           numeric(8,2),
    max_score             numeric(8,2),
    score_percent         numeric(5,2) CHECK (
                          score_percent IS NULL OR score_percent BETWEEN 0 AND 100
                        ),
    mastery_summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
    grading_version       varchar(50),
    started_at            timestamptz NOT NULL DEFAULT now(),
    submitted_at          timestamptz,
    graded_at             timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_assessment_attempt_no UNIQUE (assessment_id, owner_id, attempt_no)
);

CREATE INDEX idx_assessment_attempts_owner_assessment
    ON public.assessment_attempts(owner_id, assessment_id, attempt_no DESC);

CREATE TABLE public.assessment_answers (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id            uuid NOT NULL REFERENCES public.assessment_attempts(id) ON DELETE CASCADE,
    assessment_item_id    uuid NOT NULL REFERENCES public.assessment_items(id) ON DELETE RESTRICT,
    answer_json           jsonb NOT NULL,
    is_correct            boolean,
    score                 numeric(8,2),
    feedback              text,
    weakness_tags         text[] NOT NULL DEFAULT '{}',
    grading_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
                          -- 保存确定性评分器版本和题目/答案快照标识；不保存密钥或隐藏答案
    graded_at             timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_assessment_answer_item UNIQUE (attempt_id, assessment_item_id)
);

CREATE TABLE public.content_sources (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    visibility            varchar(20) NOT NULL DEFAULT 'catalog'
                          CHECK (visibility IN ('catalog')),
    source_type           varchar(20) NOT NULL
                          CHECK (source_type IN ('document', 'video', 'web')),
    title                 varchar(500) NOT NULL,
    canonical_url         text NOT NULL,
    provider_name         varchar(120),
    language              varchar(20) NOT NULL DEFAULT 'zh-CN',
    technology_tags       text[] NOT NULL DEFAULT '{}',
    license_note          text,
    verification_status   varchar(20) NOT NULL DEFAULT 'pending'
                          CHECK (verification_status IN ('pending', 'verified', 'invalid', 'blocked')),
    verified_at           timestamptz,
    metadata_json         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_content_sources_catalog_url
    ON public.content_sources(canonical_url);

CREATE TABLE public.content_documents (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id             uuid NOT NULL REFERENCES public.content_sources(id) ON DELETE CASCADE,
    status                varchar(20) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'parsed', 'indexed', 'failed', 'archived')),
    source_uri            text NOT NULL,
    object_uri            text,
    content_sha256        char(64),
    mime_type             varchar(120),
    parser_name           varchar(100),
    parser_version        varchar(100),
    page_count            integer CHECK (page_count IS NULL OR page_count >= 0),
    parsed_at             timestamptz,
    metadata_json         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_content_documents_source_hash UNIQUE (source_id, content_sha256)
);

CREATE INDEX idx_content_documents_source_status
    ON public.content_documents(source_id, status);

-- 已锁定 Profile siliconflow-bge-m3-v1，固定维度为 1024；不可让每条记录各自选择维度。
CREATE TABLE public.content_chunks (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id           uuid NOT NULL REFERENCES public.content_documents(id) ON DELETE CASCADE,
    ordinal               integer NOT NULL CHECK (ordinal >= 0),
    content               text NOT NULL,
    search_tsv            tsvector GENERATED ALWAYS AS (
                            to_tsvector('simple', content)
                          ) STORED,
    embedding             vector(1024),
    embedding_model       varchar(150),
    embedding_version     varchar(100),
    chunker_version       varchar(100) NOT NULL,
    token_count           integer CHECK (token_count IS NULL OR token_count >= 0),
    source_locator        jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata_json         jsonb NOT NULL DEFAULT '{}'::jsonb,
    embedded_at           timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_content_chunks_document_ordinal UNIQUE (document_id, ordinal),
    CONSTRAINT ck_content_chunks_embedding_metadata CHECK (
      (embedding IS NULL AND embedding_model IS NULL AND embedding_version IS NULL)
      OR
      (embedding IS NOT NULL AND embedding_model IS NOT NULL AND embedding_version IS NOT NULL)
    )
);

CREATE INDEX idx_content_chunks_document_ordinal
    ON public.content_chunks(document_id, ordinal);

CREATE INDEX idx_content_chunks_search_tsv
    ON public.content_chunks USING gin(search_tsv);

CREATE TABLE public.card_contents (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    plan_node_id          uuid NOT NULL REFERENCES public.plan_nodes(id) ON DELETE CASCADE,
    version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    status                varchar(20) NOT NULL DEFAULT 'generating'
                          CHECK (status IN ('generating', 'ready', 'failed', 'archived')),
    schema_version        varchar(50) NOT NULL,
    public_content_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
    runner_spec_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
    generation_metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
    content_hash          char(64),
    generated_at          timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_card_contents_node_version UNIQUE (plan_node_id, version)
);

CREATE INDEX idx_card_contents_node_status
    ON public.card_contents(plan_node_id, status, version DESC);

CREATE TABLE public.card_content_references (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    card_content_id       uuid NOT NULL REFERENCES public.card_contents(id) ON DELETE CASCADE,
    content_source_id     uuid NOT NULL REFERENCES public.content_sources(id) ON DELETE RESTRICT,
    content_document_id   uuid REFERENCES public.content_documents(id) ON DELETE SET NULL,
    content_chunk_id      uuid REFERENCES public.content_chunks(id) ON DELETE SET NULL,
    ordinal               integer NOT NULL CHECK (ordinal >= 1),
    citation_label        varchar(300) NOT NULL,
    locator_json          jsonb NOT NULL DEFAULT '{}'::jsonb,
    validation_status     varchar(20) NOT NULL DEFAULT 'verified'
                          CHECK (validation_status IN ('verified', 'stale', 'invalid')),
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_card_content_references_ordinal UNIQUE (card_content_id, ordinal)
);
```

对于 `practice/debug` 卡片，`public_content_json` 保存用户可见的 `runnable_demo`、`call_sequence` 和 `annotated_result`；`runner_spec_json` 保存允许运行的 runtime、输入、期望输出与非敏感验证摘要；`generation_metadata` 保存生成/修复次数、验证 `code_run_id` 和 schema 版本。任何包含隐藏测试、内部 Runner 地址或密钥的信息都不能写入这三个对用户可读的字段。

**向量检索决策：**检索工作流只能调用 `VectorStore` 抽象，不得出现 pgvector SQL 或 Milvus SDK。该端口可承载 dense 与 sparse 向量，但单次 `search` 只查询一种模态；`HybridRetriever` 分别获取 dense、sparse（未来）或 FTS 的排序列表，再以 RRF 融合。P0 的托管 BGE-M3 Embedding API 仅使用 dense 输出，因此以 `source_type / tag / language / verification_status` 过滤后，分别做 PostgreSQL FTS 和 `<=>` 余弦精确排序并融合即可；`tsvector` 是词法检索，不是 BGE-M3 学习型 sparse embedding。此时不建立 HNSW，导入和重嵌入更简单，也不会出现近似召回质量难以解释的问题。达到以下任一条件后，才以离线检索集压测并评审 HNSW：`content_chunks >= 50,000`、检索 p95 超过 300 ms、或精确检索已影响用户等待时间。只有当已确认的数据规模或吞吐目标仍无法由 pgvector 满足，且用户批准 backfill、双读评测、成本与回滚方案后，才实现 `MilvusVectorStore` 并切换。批准 HNSW 后执行类似以下的专用迁移（`CREATE INDEX CONCURRENTLY` 不能放在普通事务迁移中）：

```sql
CREATE INDEX CONCURRENTLY idx_content_chunks_embedding_hnsw
    ON public.content_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
```

### 3.7 全部 P0 建表 DDL（第三部分：实践、Agent 与可靠投递）

```sql
CREATE TABLE public.code_runs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    goal_id               uuid NOT NULL REFERENCES public.learning_goals(id) ON DELETE CASCADE,
    plan_node_id          uuid NOT NULL REFERENCES public.plan_nodes(id) ON DELETE CASCADE,
    card_content_id       uuid REFERENCES public.card_contents(id) ON DELETE SET NULL,
    idempotency_key       varchar(255) NOT NULL,
    runner_job_id         varchar(255),
    runtime               varchar(50) NOT NULL DEFAULT 'python-3.11',
    status                varchar(20) NOT NULL DEFAULT 'queued'
                          CHECK (status IN (
                            'queued', 'running', 'succeeded', 'failed',
                            'timeout', 'rejected', 'cancelled'
                          )),
    source_code           text NOT NULL,
    stdin_json            jsonb NOT NULL DEFAULT '{}'::jsonb,
    stdout                text,
    stderr                text,
    exit_code             integer,
    test_summary          jsonb NOT NULL DEFAULT '{}'::jsonb,
    resource_usage        jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_code            varchar(100),
    started_at            timestamptz,
    finished_at           timestamptz,
    expires_at            timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_code_runs_owner_idempotency UNIQUE (owner_id, idempotency_key)
);

CREATE INDEX idx_code_runs_owner_node_created
    ON public.code_runs(owner_id, plan_node_id, created_at DESC);

CREATE TABLE agent.agent_runs (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id                uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    run_type                varchar(40) NOT NULL
                            CHECK (run_type IN (
                              'assessment_generate', 'plan_generate',
                              'card_content_generate', 'adaptation'
                            )),
    status                  varchar(20) NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
    target_type             varchar(50) NOT NULL,
    target_id               uuid NOT NULL,
    idempotency_key         varchar(255) NOT NULL,
    trace_id                varchar(128) NOT NULL,
    graph_version           varchar(100) NOT NULL,
    prompt_version          varchar(100),
    input_schema_version    varchar(100) NOT NULL,
    output_schema_version   varchar(100),
    requested_model_profile varchar(100) NOT NULL,
    model_connection_id     uuid REFERENCES public.user_model_connections(id) ON DELETE SET NULL,
    requested_model_id      varchar(255),
    actual_model_profile    varchar(100),
    fallback_reason         varchar(255),
    input_tokens            integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens           integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    estimated_cost_usd      numeric(12,6) NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
    retry_count             integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    input_summary_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
    output_summary_json     jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_code              varchar(100),
    error_summary           text,
    started_at              timestamptz,
    finished_at             timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_agent_runs_idempotency
        UNIQUE (owner_id, run_type, idempotency_key)
);

CREATE INDEX idx_agent_runs_owner_status_created
    ON agent.agent_runs(owner_id, status, created_at DESC);

CREATE INDEX idx_agent_runs_target
    ON agent.agent_runs(target_type, target_id, created_at DESC);

CREATE TABLE agent.agent_run_events (
    id                    bigserial PRIMARY KEY,
    agent_run_id          uuid NOT NULL REFERENCES agent.agent_runs(id) ON DELETE CASCADE,
    sequence_no           integer NOT NULL CHECK (sequence_no >= 1),
    event_type            varchar(80) NOT NULL,
    payload_json          jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_agent_run_events_sequence UNIQUE (agent_run_id, sequence_no)
);

CREATE INDEX idx_agent_run_events_run_sequence
    ON agent.agent_run_events(agent_run_id, sequence_no);

CREATE TABLE public.outbox_events (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type        varchar(80) NOT NULL,
    aggregate_id          uuid NOT NULL,
    event_type            varchar(120) NOT NULL,
    event_version         integer NOT NULL DEFAULT 1,
    payload_json          jsonb NOT NULL,
    trace_id              varchar(128),
    status                varchar(20) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'published', 'failed', 'dead')),
    available_at          timestamptz NOT NULL DEFAULT now(),
    locked_by             varchar(100),
    locked_at             timestamptz,
    attempt_count         integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error            text,
    published_at          timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_events_poll
    ON public.outbox_events(status, available_at, created_at)
    WHERE status IN ('pending', 'failed');

CREATE TABLE public.idempotency_keys (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_key             varchar(300) NOT NULL, -- user UUID 或认证前的规范化身份摘要
    scope                 varchar(120) NOT NULL,
    idempotency_key       varchar(255) NOT NULL,
    request_hash          char(64) NOT NULL,
    status                varchar(20) NOT NULL DEFAULT 'processing'
                          CHECK (status IN ('processing', 'succeeded', 'failed')),
    response_status       integer,
    resource_type         varchar(80),
    resource_id           uuid,
    response_json         jsonb NOT NULL DEFAULT '{}'::jsonb,
    expires_at            timestamptz NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_idempotency_actor_scope_key UNIQUE (actor_key, scope, idempotency_key)
);

CREATE INDEX idx_idempotency_keys_expiry
    ON public.idempotency_keys(expires_at);
```

`outbox_events` 的最小可靠投递流程为：同一数据库事务中完成核心聚合变更、创建 `agent.agent_runs` 和 `INSERT outbox_events`；独立 `agent-dispatcher` 使用 `SELECT ... FOR UPDATE SKIP LOCKED` 领取 `agent.run.requested`，投递到 Celery 后回写状态。Celery Worker 仅推进 `agent.agent_runs` 与 `agent.agent_run_events`，再经内部 Core API 持久化结构化业务结果。Dispatcher 在“已发送、未回写”间中断时允许重复投递，`agent_run_id` 同时作为 Celery `task_id` 与幂等边界。`outbox_events` 是跨上下文基础设施例外，不是 Worker 可以任意修改核心表的通行证。

P0 的 `assessment_items` 仅允许 `single_choice`：`answer_key_json` 保存隐藏正确选项，服务端同步完成确定性评分，并在 `grading_metadata_json` 保存评分器与题目/答案版本标识。`rubric_json` 是为避免破坏旧迁移而保留的历史兼容列，P0 不读取或写入它。`assessment_evaluate` 与 `card_quiz_generate` 已从 AgentRun 类型中移除，任何 P0 路径均不得创建这两类任务。

### 3.8 `updated_at` Trigger 与迁移顺序

所有包含 `updated_at` 的表必须挂触发器：`users`、`auth_sessions`、`user_model_connections`、`learner_profiles`、`learning_goals`、`learning_plans`、`plan_nodes`、`assessments`、`assessment_attempts`、`assessment_answers`、`content_sources`、`content_documents`、`card_contents`、`code_runs`、`agent.agent_runs`、`idempotency_keys`。

```sql
CREATE TRIGGER trg_users_touch_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 其余表在同一迁移中按相同模式建立 trigger；不要依赖应用代码“记得更新”。
```

当前初始库使用一个可审查的 `0000_initial_p0_schema`：其中包含 22 张表、`pgcrypto`/`citext`/`vector` 扩展、`agent` schema、索引、外键和 15 个 `updated_at` trigger，已在本地 Docker PostgreSQL 验证。`0003_user_model_connections` 以增量方式新增第 23 张表、目标/AgentRun 选择快照字段与第 16 个 trigger；上线后不得重写历史迁移，所有变更必须由新的增量迁移表达。

原先规划的逻辑拆分保留为后续迁移的职责参考：

```text
0001_<下一项增量变更>
0002_<下一项增量变更>
...
00xx_langgraph_checkpoint_vendor_schema
```

`0009` 必须锁定 `langgraph-checkpoint-postgres` 版本，并把该版本的官方 DDL 以 raw SQL 纳入迁移仓库。不要在每次应用启动时无条件调用 `PostgresSaver.setup()` 改动生产 schema。

### 3.9 P1 / P2 预留表

| 阶段 | 建议新增表 | 作用 |
| --- | --- | --- |
| P1 | `oauth_accounts`、`email_verification_tokens`、`password_reset_tokens` | OAuth/Magic Link、邮箱验证与安全找回密码。 |
| P1 | `content_ingestion_jobs`、`content_source_access`、`content_chunk_embeddings` | 用户资料导入、MinerU、私有资料授权、多版本重嵌入。 |
| P1 | `model_usage_ledger`、`plan_change_sets`、`data_deletion_jobs` | 用户成本/配额、路线回退、数据删除编排。 |
| P1 | `model_connection_verification_events`、`egress_policy_audits` | 自定义 Base URL 的 SSRF 受控出网、DNS/重定向复核和连接验证审计。 |
| P2 | `organizations`、`organization_members`、`roles` | 多租户组织与权限。 |
| P2 | `progress_snapshots`、`learning_reports`、`achievements` | 进度条、学习报告和成就投影。 |
| P2 | `posts`、`comments`、`reactions`、`groups` | 社区/社群。 |
| P2 | `subscriptions`、`billing_events`、`notifications` | 商业化与通知。 |

---

## 4. 核心 API 设计

### 4.1 通用约定

| 项目 | 约定 |
| --- | --- |
| API 前缀 | 浏览器 API 使用 `/api/v1`；仅服务间使用 `/internal/v1`，绝不通过公网暴露 Worker 写入接口。 |
| 身份 | 浏览器由 `lc_session` HttpOnly Cookie 认证；内部 Web → Worker / Worker → Web 使用短期服务令牌或 HMAC 签名。 |
| 命名 | HTTP JSON 使用 `snake_case`，数据库字段同名；前端内部 view model 可自行转成 `camelCase`。 |
| 写操作 | 除注册、登录、退出外，所有可能创建任务、生成内容或运行代码的 POST 请求都必须带 `Idempotency-Key`。 |
| 异步 | 返回 `202 Accepted` 时必有 `agent_run_id` 或 `code_run_id`；客户端查询状态或订阅 SSE，不等待模型调用完成。 |
| 错误格式 | `{ "error": { "code": "PLAN_NOT_READY", "message": "路线仍在生成", "trace_id": "..." } }`；不把数据库异常、密钥或完整模型响应返回浏览器。 |
| 授权 | 所有资源路由先取 Session 用户，再以 `resource_id + owner_id` 查询；查不到统一 `404`。 |
| 时间 | 请求和响应时间用 ISO 8601 UTC，例如 `2026-07-18T12:00:00Z`。 |

### 4.2 认证 API

#### 注册

```http
POST /api/v1/auth/register
Content-Type: application/json

{
  "email": "learner@example.com",
  "display_name": "Stephy",
  "password": "a-long-unique-password"
}
```

```http
HTTP/1.1 201 Created

{
  "id": "c7a1f6f9-5b06-4dc2-8ea5-8ffc3c8d4f69",
  "email": "learner@example.com",
  "display_name": "Stephy"
}
```

注册只创建账号，不创建 `auth_sessions` 记录，也不会返回 `Set-Cookie`；客户端必须再调用登录接口取得 Session。

#### 登录、登出与当前用户

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "learner@example.com", "password": "a-long-unique-password" }

HTTP/1.1 200 OK
Set-Cookie: lc_session=<opaque-random-token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=259200

{ "id": "c7a1f6f9-5b06-4dc2-8ea5-8ffc3c8d4f69", "email": "learner@example.com", "display_name": "Stephy" }

POST /api/v1/auth/logout
HTTP/1.1 204 No Content
Set-Cookie: lc_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0

GET /api/v1/auth/me
HTTP/1.1 200 OK

{
  "id": "c7a1f6f9-5b06-4dc2-8ea5-8ffc3c8d4f69",
  "email": "learner@example.com",
  "display_name": "Stephy",
  "profile_completed": true
}
```

> **为什么不按示例返回 JWT？**LearnCraft P0 是同域 Web 应用，Next.js BFF 用 HttpOnly Cookie 可以避免前端 JavaScript 持有长期访问令牌。服务器只保存随机 token 的哈希，泄露数据库也不能直接重放 Session。以后做移动端/第三方 API 时，再单独设计短期 Access Token + Refresh Token 流程，而不是现在混入浏览器登录。

### 4.3 模型连接 API

模型连接为当前账户私有资源，支持一个账户默认连接。`api_key` 是仅写字段：创建时必须提供，更新时仅在替换 Key 时提供，任何成功或失败响应都不会回传它或其密文。P0 允许自定义 HTTP/HTTPS Base URL，但实际 Worker 出网必须等 P1 SSRF 受控出网层完成后才可启用。

| 方法与路径 | 用途 | 成功响应 |
| --- | --- | --- |
| `GET /api/v1/model-connections` | 列出当前用户的安全连接摘要 | `200` `{ items: ModelConnection[] }` |
| `POST /api/v1/model-connections` | 加密保存连接，可同时设为账户默认 | `201` `ModelConnection` |
| `PATCH /api/v1/model-connections/{model_connection_id}` | 修改名称、Base URL、默认模型或替换 API Key | `200` `ModelConnection` |
| `POST /api/v1/model-connections/{model_connection_id}/default` | 设置账户默认连接 | `200` `ModelConnection` |
| `DELETE /api/v1/model-connections/{model_connection_id}` | 删除连接，解除可选目标/运行记录关联 | `204` |

```http
POST /api/v1/model-connections
Content-Type: application/json

{
  "display_name": "我的 DeepSeek",
  "base_url": "https://api.deepseek.com",
  "api_key": "仅在本次请求发送的密钥",
  "default_model_id": "deepseek-chat",
  "set_as_default": true
}

HTTP/1.1 201 Created

{
  "id": "model-connection-uuid",
  "display_name": "我的 DeepSeek",
  "protocol": "openai_compatible",
  "base_url": "https://api.deepseek.com",
  "default_model_id": "deepseek-chat",
  "status": "active",
  "is_default": true
}
```

### 4.4 画像、目标与前测 API

| 方法与路径 | 用途 | 成功响应 |
| --- | --- | --- |
| `GET /api/v1/profile` | 读取当前用户画像 | `200` Profile |
| `PUT /api/v1/profile` | 创建/更新画像 | `200` Profile（`profile_version` +1） |
| `POST /api/v1/learning-goals` | 创建 Python 基础目标 | `201` Goal |
| `GET /api/v1/learning-goals/{goal_id}` | 读取目标及当前状态 | `200` Goal |
| `POST /api/v1/learning-goals/{goal_id}/diagnostic-assessments` | 请求前测生成 | `202` `{ assessment_id, agent_run_id, status }` |
| `GET /api/v1/assessments/{assessment_id}` | 读取题目或结果 | `200`；进行中不包含 `answer_key_json`、`rubric_json` 或评分内部元数据 |
| `POST /api/v1/assessments/{assessment_id}/attempts` | 创建/恢复一次作答 | `201` Attempt |
| `PUT /api/v1/assessment-attempts/{attempt_id}/answers/{item_id}` | 保存单题答案 | `200` Answer 摘要 |
| `POST /api/v1/assessment-attempts/{attempt_id}/submit` | 提交并评分 | `202` `{ attempt_id, agent_run_id, status: "queued" }` |

创建目标示例：

```http
POST /api/v1/learning-goals
Idempotency-Key: 5301bb75-b6a7-4d0a-9d58-3edc6b3b5999
Content-Type: application/json

{
  "subject_key": "python-311-basics",
  "title": "两周掌握 Python 基础并写一个命令行待办程序",
  "description": "我会一点 JavaScript，但没有 Python 基础。",
  "desired_outcome": "能理解变量、函数、列表和错误，并完成一个小项目。",
  "target_date": "2026-08-01",
  "weekly_minutes_override": 300,
  "model_connection_id": "model-connection-uuid"
}

HTTP/1.1 201 Created

{
  "id": "79a55d76-46ed-4e7b-b4c0-1641c4a1d7d9",
  "status": "assessment_pending",
  "subject_key": "python-311-basics"
}
```

#### 前测 / 路线后测共用题目与提交合同

`diagnostic`（前测）与 `post_test`（路线后测）共用单选题公开题目和作答 API。前测由用户选择 10–20 题（默认推荐 12），并指定 `normal` 或 `hard`；`normal` 从基础到进阶逐步提升，`hard` 在相同题序上整体提高基线。路线后测要求 `plan_id`，由用户选择 5–10 题（推荐 5–8），覆盖已完成路线的关键目标。两者都不向浏览器返回隐藏答案。

```json
{
  "id": "assessment-uuid",
  "kind": "diagnostic",
  "requested_question_count": 12,
  "difficulty": "normal",
  "status": "ready",
  "items": [
    {
      "id": "choice-item-uuid",
      "item_type": "single_choice",
      "prompt": "以下哪一个值是 Python 列表？",
      "options": [
        { "id": "A", "text": "{}" },
        { "id": "B", "text": "[]" },
        { "id": "C", "text": "()" }
      ],
      "max_score": 1
    }
  ]
}
```

```http
POST /api/v1/assessment-attempts/{attempt_id}/submit
Idempotency-Key: 45eea8f4-1b19-4512-a702-5dd991e28122
Content-Type: application/json

{
  "answers": [
    {
      "item_id": "choice-item-uuid",
      "answer": { "selected_option_id": "B" }
    }
  ]
}

HTTP/1.1 200 OK

{
  "attempt_id": "attempt-uuid",
  "status": "graded",
  "score_percent": 100,
  "weakness_tags": []
}
```

确定性评分的公开结果只返回分数、反馈和薄弱点；不会返回隐藏参考答案、评分内部元数据、系统提示词或模型密钥。路线后测结果可用于生成下一路线的复习或提高难度建议。

`model_connection_id` 是可选的目标级覆盖值。服务端必须先按当前 `owner_id` 验证该连接处于 `active` 状态；缺省时，在真正创建生成任务时解析账户默认连接。

### 4.5 路线与卡片内容 API

| 方法与路径 | 用途 | 成功响应 |
| --- | --- | --- |
| `POST /api/v1/learning-goals/{goal_id}/plans` | 根据已评分前测请求生成路线 | `202` `{ plan_id, agent_run_id, status }` |
| `GET /api/v1/learning-plans/{plan_id}` | 读取路线和节点摘要 | `200` Plan；不返回内部 prompt/模型密钥 |
| `GET /api/v1/plan-nodes/{node_id}` | 读取节点详情 | `200` Node |
| `POST /api/v1/plan-nodes/{node_id}/card-contents` | 请求/重试生成卡片 | `202` `{ card_content_id, agent_run_id, status }` |
| `GET /api/v1/card-contents/{card_content_id}` | 读取已完成卡片 | `200`；`practice/debug` 卡含已验证 Demo、调用顺序和注释结果；不含隐藏测试/评分依据 |
| `POST /api/v1/learning-plans/{plan_id}/post-test-assessments` | 路线所有节点完成后请求后测 | `202` `{ assessment_id, agent_run_id, status }` |

路线生成示例：

```http
POST /api/v1/learning-goals/79a55d76-46ed-4e7b-b4c0-1641c4a1d7d9/plans
Idempotency-Key: bdea9d83-4558-4172-8997-a7f3f97b7b7e

HTTP/1.1 202 Accepted

{
  "plan_id": "ddce642a-4e39-451a-a5c1-20ad7040c51b",
  "agent_run_id": "a571c1e2-3e23-4c92-b7a7-748c24e50ed3",
  "status": "queued"
}
```

实战 / 调试卡片响应的关键片段：

```json
{
  "plan_node_id": "node-uuid",
  "phase": "practice",
  "runnable_demo": {
    "language": "python-3.11",
    "source_code": "def add(a, b):\n    return a + b\n\nprint(add(2, 3))\n",
    "stdin": "",
    "expected_stdout": "5\n",
    "validation": {
      "code_run_id": "system-demo-run-uuid",
      "status": "succeeded",
      "observed_stdout": "5\n"
    }
  },
  "call_sequence": [
    { "step": 1, "symbol": "__main__", "action": "调用 add(2, 3)" },
    { "step": 2, "symbol": "add", "action": "计算 a + b 并返回 5" },
    { "step": 3, "symbol": "print", "action": "输出返回值 5" }
  ],
  "annotated_result": [
    { "step": 1, "explanation": "程序入口发起函数调用。" },
    { "step": 2, "explanation": "add 接收两个参数并返回计算结果。" },
    { "step": 3, "observed_stdout": "5", "explanation": "print 将返回值写入标准输出。" }
  ]
}
```

该 `validation` 由系统在内容发布前产生，不能由模型自行声称“可运行”而跳过 Runner。

### 4.6 代码实践、Agent 状态与内部 API

| 方法与路径 | 用途 | 成功响应 |
| --- | --- | --- |
| `POST /api/v1/plan-nodes/{node_id}/code-runs` | 在学习卡片上下文提交受限 Python 代码；独立于 LangGraph | `202` `{ code_run_id, status: "queued" }` |
| `GET /api/v1/code-runs/{code_run_id}` | 查询运行结果 | `200` stdout/stderr/test summary/resource usage |
| `GET /api/v1/agent-runs/{agent_run_id}` | 查询长任务快照 | `200` 状态、进度摘要、错误类别、trace ID |
| `GET /api/v1/agent-runs/{agent_run_id}/events` | 可选 SSE 订阅/重放 | `200 text/event-stream`；支持 `Last-Event-ID` |
| `POST /internal/v1/agent-runs/{agent_run_id}/results` | Worker 回写校验后的业务结果 | 仅服务身份可用，`204` |
| `POST /internal/v1/agent-runs/{agent_run_id}/failures` | Worker 回写安全失败摘要 | 仅服务身份可用，`204` |

代码运行请求示例：

```http
POST /api/v1/plan-nodes/8c922ec9-2ba4-4510-9e1e-2ad69fcbb57f/code-runs
Idempotency-Key: e856c23c-a6fa-4bf0-8405-55b8d5701d56
Content-Type: application/json

{
  "source_code": "name = input()\nprint(f'Hello, {name}!')\n",
  "stdin": "LearnCraft\n"
}

HTTP/1.1 202 Accepted

{ "code_run_id": "d098af18-8839-488a-a8b8-476b867e8e86", "status": "queued" }
```

### 4.7 API 需要先写入的契约

`packages/contracts/openapi/core.yaml` 是 Web 与 Worker 的唯一跨语言 HTTP 契约来源。P0 至少定义：

- Auth、ModelConnection、Profile、Goal、Assessment、Plan、Node、CardContent、CodeRun、AgentRun 的 request/response schema；
- `AssessmentItem`（仅 `single_choice`）、`AssessmentGrade`、`RunnableDemoSpec`、`DemoValidationResult`、`CallSequenceStep` 与 `AnnotatedResultStep` schema；
- `AgentRunRequested`、`PlanGenerated`、`CardContentGenerated`、`CodeRunFinished` 的事件信封 JSON Schema；
- 统一错误、分页（如需要）、`trace_id` 和幂等冲突响应；
- internal endpoint 的服务认证要求与所有权边界。

前端 Route Handler 用 Zod 校验浏览器输入；FastAPI、队列事件和 LLM 结构化输出用 Pydantic 校验；二者都不能直接把 ORM Model 当接口 DTO。

---

## 5. 核心流程设计图

### 5.1 注册、画像、前测、路线生成主流程

```mermaid
sequenceDiagram
    actor U as 用户
    participant W as Next.js Web/BFF
    participant DB as PostgreSQL
    participant O as Outbox
    participant A as Python Agent Worker
    participant M as 用户配置的模型 Provider

    U->>W: 注册
    W->>DB: 创建用户 + Argon2id hash
    DB-->>W: 用户
    W-->>U: 201 Created（不设置 Cookie）
    U->>W: 登录
    W->>DB: 校验用户 + 创建 Session
    DB-->>W: 用户与 Session
    W-->>U: Set-Cookie + 当前用户
    U->>W: 保存模型连接或选择账户默认
    W->>DB: 加密保存连接（不写入 Outbox）
    U->>W: 提交画像与学习目标（可覆盖模型连接）
    W->>DB: 保存 Profile、Goal(status=assessment_pending, model_connection_id?)
    U->>W: 请求前测
    W->>DB: 创建 Assessment(generating) + Outbox(event)
    O-->>A: 领取 assessment.generate
    A->>M: 生成用户指定的 10–20 题单选前测
    M-->>A: 结构化题目
    A->>A: Pydantic + 单选题/隐藏答案/题量/难度校验
    A->>W: Internal API 回写题目
    W->>DB: Assessment(status=ready)
    U->>W: 作答并提交
    W->>DB: Attempt + Answers
    W->>W: 按隐藏答案确定性评分
    W->>DB: Goal(status=planning) + Outbox(plan.generate)
    O-->>A: 领取 plan.generate
    A->>M: 生成路线 JSON
    A->>A: Schema、阶段覆盖、DAG、时长校验
    A->>W: Internal API 回写激活路线
    W->>DB: Plan(active) + 首节点(available)
    W-->>U: 路线可见
```

### 5.2 节点内容、检索与引用流程

```mermaid
flowchart LR
    U[用户点击 available 节点] --> W[Web 创建 CardContent + AgentRun]
    W --> OB[(Outbox)]
    OB --> AW[Agent Worker]
    AW --> F[按来源状态/标签/语言过滤]
    F --> R[RetrieverPort: FTS + pgvector 精确召回]
    R --> C[返回 source/document/chunk/locator]
    C --> MG[ModelGateway: content profile]
    MG --> LLM[托管模型 API]
    LLM --> V[Pydantic 内容 Schema + 引用校验]
    V --> P{practice/debug 节点?}
    P -->|否| API[Internal Core API]
    P -->|是| DV[Runner 预运行 Demo并比对预期输出]
    DV -->|成功| API
    DV -->|失败| RETRY[修复一次或模板兜底]
    V -->|Schema/引用失败| RETRY
    RETRY --> V
    API --> DB[(CardContent + References)]
    DB --> U
```

**不可绕过的检查：**模型只能看到获准的检索摘要；内容结果中的引用必须能映射到已有 `content_source/document/chunk`；若无法映射，标记为“模型推断”或使任务失败，不能虚构 URL/页码。`practice/debug` 节点还必须通过受限 Runner 预运行：实际 stdout/退出码与 Demo 声明一致后，才可以把 `validated_code_run_id`、调用顺序和注释结果回写给用户。

### 5.3 代码运行、测验和动态路线调整

```mermaid
flowchart TD
    A[打开实战/调试节点] --> D[展示已验证 AI Demo、调用顺序和注释结果]
    D --> B[用户编辑/提交代码]
    B --> C[Runner 领取任务]
    C --> D{隔离策略通过?}
    D -->|否| E[rejected + 安全文案]
    D -->|是| F[一次性 Python 3.11 沙箱执行]
    F --> G{超时/资源超限?}
    G -->|是| H[timeout + 回收环境]
    G -->|否| I[保存 stdout/stderr/隐藏测试摘要]
    I --> J[节点完成；按前置关系解锁下一节点]
    J --> K{整条路线所有节点完成?}
    K -->|否| A
    K -->|是| L[用户选择 5–10 题路线后测]
    L --> M[服务端按隐藏答案确定性评分]
    M --> N{后测 >= 80% 且相关代码通过?}
    N -->|是| O[路线标记掌握]
    N -->|否，50-79%| P[建议复习并允许重测]
    N -->|否，<50% 或连续失败| Q[建议下一路线补强主题]
    O --> R[记录 AdaptationEvent]
    P --> R
    Q --> R
```

### 5.4 AgentRun 状态机

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> running: Worker 领取 Outbox
    queued --> cancelled: 用户/系统取消
    running --> succeeded: 结构化结果已持久化
    running --> failed: 不可恢复错误或预算耗尽
    running --> queued: 可恢复错误且仍可重试
    running --> cancelled: 取消确认
    queued --> expired: 超过过期时间
    failed --> queued: 用户显式重试（新 idempotency key）
    succeeded --> [*]
    cancelled --> [*]
    expired --> [*]
```

`AgentRun` 的失败只代表“编排没有完成”，不自动改变业务聚合为错误状态。由 Core 应用服务结合 `run_type`、目标当前版本和幂等键决定是否把 Goal、Plan、Assessment 或 CardContent 标为 `failed`，避免旧任务覆盖新版本结果。

---

## 6. 目录分层与具体职责

本节是 `02-DDD项目目录.md` 的 P0 视图。目录名可以微调，但依赖方向不能反过来：**interface → application → domain；infrastructure 实现 domain/application 定义的 port；Python 不持有 Web 的业务 ORM。**

```text
learncraft/
├─ apps/
│  ├─ web/                                      # Next.js UI + BFF + 核心业务写模型
│  │  ├─ src/app/                               # 页面、Route Handlers；只做薄 HTTP 适配
│  │  ├─ src/modules/
│  │  │  ├─ identity/
│  │  │  ├─ profile/
│  │  │  ├─ planning/
│  │  │  ├─ assessment/
│  │  │  ├─ content/
│  │  │  ├─ practice/
│  │  │  └─ agent-run/
│  │  ├─ src/lib/                               # db、session、outbox、logger 等框架适配
│  │  └─ tests/{unit,integration,e2e}/
│  └─ agent-worker/                             # Python FastAPI + LangGraph
│     ├─ alembic/README.md                      # P0 仅保留“不可与 Drizzle 并用”的说明
│     ├─ src/learncraft_agent/
│     │  ├─ core/                               # config、logging、security、DI
│     │  ├─ interfaces/http/                    # /health、/internal/runs；Pydantic HTTP schema
│     │  ├─ application/                        # RunService、ModelGateway、commands、ports、DTO
│     │  ├─ domain/                             # AgentRunPolicy、BudgetPolicy、repository interfaces
│     │  ├─ workflows/                          # LangGraph graphs、states、nodes、输出 schema
│     │  ├─ acl/                                # Core API DTO ↔ Agent DTO 转换
│     │  ├─ tools/                              # profile、plan、retrieval、assessment、execution 工具
│     │  ├─ infrastructure/                     # provider、pgvector、SQLAlchemy、Outbox、checkpoint
│     │  └─ main.py
│     ├─ tests/{unit,integration,e2e}/
│     └─ pyproject.toml
├─ db/
│  ├─ migrations/                               # P0 唯一迁移入口（Drizzle 生成/维护）
│  ├─ seeds/                                    # 受控内容、题库、检索评测数据
│  └─ schema/                                   # Drizzle tables / relation 定义
├─ packages/
│  ├─ contracts/openapi/core.yaml               # 跨语言 HTTP 契约唯一来源
│  ├─ contracts/events/                         # Outbox/event JSON Schema
│  └─ ui/                                       # 无业务规则的共享 UI 组件
├─ infra/
│  ├─ compose.yaml
│  └─ docker/{web,agent-worker,code-runner}.Dockerfile
├─ scripts/{dev,db-migrate,generate-contracts}.ps1
├─ .env.example
├─ pnpm-workspace.yaml
└─ README.md
```

### 6.1 Web 领域模块的四层职责

每个 `apps/web/src/modules/<bounded-context>/` 使用相同的最小模板：

| 层 | 目录 | 应做的事 | 不应做的事 |
| --- | --- | --- | --- |
| Domain | `domain/` | 聚合、实体、值对象、状态转移、领域策略、repository interface、领域事件。 | import Next `Request`、Drizzle record、React、HTTP client。 |
| Application | `application/` | Command/Query handler、事务边界、授权后的用例编排、调用 port。 | 直接拼 SQL、承载页面 UI。 |
| Infrastructure | `infrastructure/` | Drizzle repository、Outbox publisher、Runner/Agent HTTP adapter、对象存储 adapter。 | 把基础设施 DTO 传回 UI 当领域对象。 |
| Interfaces | `interfaces/` 与 `app/api/` | Zod 请求校验、session 提取、HTTP status、presenter。 | 直接实施业务规则或访问数据库表。 |

示例：`planning/application/commands/request-plan-generation.ts` 在一个事务里创建 `learning_plans(status=generating)`、首条 `agent_runs` 的业务引用和 Outbox 事件；它不等待模型响应。`agent-worker` 完成后调用内部结果接口，由 `planning` 用例再校验、持久化节点和激活路线。

### 6.2 Python Agent Worker 的层职责

| 用户熟悉的目录 | LearnCraft 中的位置 | P0 职责 | 边界 |
| --- | --- | --- | --- |
| `core/` | `core/config.py`、`logging.py`、`security.py`、`dependencies.py` | Pydantic Settings、模型 profile、密钥读取、结构化日志、内部服务鉴权、连接池。 | 不写路线、题目或用户权限规则。 |
| `schemas/` | `interfaces/http/schemas/`、`workflows/schemas/`、`application/dto/` | Pydantic 校验 HTTP、Outbox、Core API DTO、LLM 输出和图状态。 | 不能充当 SQLAlchemy ORM 或共享给浏览器。 |
| `services/` | `application/services/` | `RunService`、`ModelGateway`、重试/预算门面。 | 不直接依赖 FastAPI Request 或 SQLAlchemy session。 |
| `repositories/` | `domain/repositories/` + `infrastructure/persistence/repositories/` | AgentRun / event / checkpoint 的接口和实现。 | 不直接更新 `public.learning_plans`、`public.assessments`、`public.users`。 |
| `models/` | `infrastructure/persistence/models/` | SQLAlchemy 表映射，仅限 `agent.agent_runs`、`agent.agent_run_events`。 | 不复制 TypeScript 的核心业务模型。 |
| `workflows/` | `workflows/<use_case>/` | LangGraph 的有状态编排：输入标准化、检索、生成、结构校验、回写。 | 不把学习规则藏到 prompt。 |
| `alembic/` | `apps/agent-worker/alembic/` | P0 只放 README，说明 Drizzle 是唯一迁移所有者。 | 不生成/执行第二套业务迁移。 |

### 6.3 数据库基类、ORM 与 DTO 的正确关系

Python SQLAlchemy 基类只服务 Agent 自有表。P0 的推荐写法如下（示意）：

```python
# apps/agent-worker/src/learncraft_agent/infrastructure/persistence/base.py
from datetime import datetime
from sqlalchemy import DateTime, func
from sqlalchemy.ext.asyncio import AsyncAttrs
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(AsyncAttrs, DeclarativeBase):
    """只映射 agent schema 的基础设施表。"""


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
```

```python
# infrastructure/persistence/models/agent_run.py（示意）
from uuid import UUID, uuid4
from sqlalchemy import String, Uuid
from sqlalchemy.orm import Mapped, mapped_column
from ..base import Base, TimestampMixin


class AgentRunRecord(TimestampMixin, Base):
    __tablename__ = "agent_runs"
    __table_args__ = {"schema": "agent"}

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    owner_id: Mapped[UUID] = mapped_column(Uuid, nullable=False)
    run_type: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    trace_id: Mapped[str] = mapped_column(String(128), nullable=False)
```

公共业务表的“基类复用”放在 Drizzle 侧的字段 helper，而不是 Python `Base`：

```ts
// db/schema/_columns.ts（示意）
import { timestamp } from "drizzle-orm/pg-core";

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};
```

仍需用第 3 节的数据库 trigger 更新 `updated_at`。`timestamps` 只是声明字段，不是数据库自动更新机制。

### 6.4 表、模型和 API DTO 的边界

```text
浏览器表单 ── Zod ──> Route Handler
                              │
                              ├── Application DTO / Domain command
                              │        │
                              │        └── Drizzle record（public 业务表）
                              │
                              └── OpenAPI / JSON Schema ──> FastAPI Pydantic DTO
                                                                  │
                                                                  ├── LangGraph State
                                                                  └── SQLAlchemy record（agent 表）
```

- Zod：保护浏览器到 Next.js 的输入边界；
- Pydantic：保护 FastAPI、Outbox、Core API 和 LLM 的输入输出边界；
- Drizzle/SQLAlchemy：持久化映射；
- Domain Entity/Value Object：实现业务规则。

四者都可以有相似字段，但不能相互替代或跨语言直接复用。

---

## 7. 推荐编程步骤（从空仓库到可联调 P0）

下面按依赖顺序执行。每一步都有明确产物；不要先写复杂 LangGraph 或 UI，再补认证、数据模型和契约。

### 步骤 0：准备本地工具与版本

准备 Node.js 20.9+、Corepack/pnpm、Python 3.11、`uv`、Docker Desktop（含 Compose v2）和 Git。Next.js 当前安装文档要求 Node.js 20.9 以上；版本应写入 `.nvmrc`/`.tool-versions`、`pyproject.toml`、lockfile 和 Docker 镜像标签，而不是依赖 `latest`。

PowerShell 中确认：

```powershell
node --version
corepack --version
python --version
uv --version
docker compose version
```

### 步骤 1：建立 pnpm 工作区和 Next.js Web

```powershell
corepack enable
pnpm create next-app@latest apps/web --ts --tailwind --eslint --app --src-dir --use-pnpm --import-alias "@/*"
```

在仓库根目录创建工作区清单后，安装 P0 所需包（命令中的版本由 lockfile 固定）：

```powershell
pnpm --dir apps/web add drizzle-orm pg zod @hookform/resolvers react-hook-form argon2
pnpm --dir apps/web add -D drizzle-kit @types/pg vitest @playwright/test openapi-typescript
```

Web 侧的最小脚本目标：

```text
pnpm --dir apps/web lint
pnpm --dir apps/web typecheck
pnpm --dir apps/web test
pnpm --dir apps/web test:e2e
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

`argon2` 必须在开发机和 Linux Docker 镜像中验证为 Argon2id 实现；若选择另一维护良好的 Node Argon2 绑定，接口和安全参数不变。

### 步骤 2：用 uv 建立 Python Agent Worker

从根目录执行：

```powershell
uv python install 3.11
uv init --package --python 3.11 apps/agent-worker
Set-Location apps/agent-worker

uv add fastapi "uvicorn[standard]" pydantic pydantic-settings `
  sqlalchemy asyncpg httpx structlog tenacity orjson `
  langchain langgraph langgraph-checkpoint-postgres pgvector
uv add --group dev pytest pytest-asyncio pytest-cov ruff mypy

# 仅在选定 Provider 后安装对应 LangChain integration；例如 Provider 为 OpenAI-compatible 时：
uv add langchain-openai

uv lock
uv sync --all-groups
uv run ruff check .
uv run pytest
```

产物是 `apps/agent-worker/pyproject.toml`、`uv.lock` 和项目级 `.venv`。后续始终用 `uv run ...` 调用 Worker、测试和格式检查，不再手工激活一个无法复现的全局虚拟环境。

### 步骤 3：先写契约、目录空壳和健康检查

1. 按第 6 节建立目录；每个目录先加最小 README 或空 `__init__.py`，使职责一眼可见。
2. 先写 `packages/contracts/openapi/core.yaml` 的 Auth、Goal、AgentRun 和统一 Error schema；生成 TypeScript client/type 与 Python DTO 骨架。
3. Web 实现 `GET /api/v1/health`，Worker 实现仅内网可达的 `GET /health`。健康检查只验证进程、数据库连通性和必需配置是否齐全，不调用真实模型。
4. 增加 `GET /api/v1/version`，返回 git SHA、schema version、embedding profile version（不返回密钥）。
5. 创建 `apps/agent-worker/alembic/README.md`：明确写入“P0 使用 Drizzle；不得执行 `alembic upgrade`”。

### 步骤 4：锁定 embedding Profile 后创建 Drizzle Schema 与迁移

这一步之前已在 ADR/`.env.example` 锁定五项值：`EMBEDDING_PROVIDER=SiliconFlow`、`EMBEDDING_MODEL=BAAI/bge-m3`、`EMBEDDING_DIMENSION=1024`、`EMBEDDING_METRIC=cosine`、`EMBEDDING_PROFILE_VERSION=siliconflow-bge-m3-v1`。首份迁移已使用 `vector(1024)`，P0 不允许运行时随意修改它。

实施顺序：

1. 已在 `apps/web/src/lib/db/schema/` 按第 3.2 节的文件归属声明全部 23 张表与 relation；其中 `0003_user_model_connections` 为用户模型连接及目标/AgentRun 选择快照的增量迁移；
2. 将扩展、schema、CHECK、partial index、trigger、HNSW（暂不创建）等 Drizzle 不擅长表达的部分放在 migration raw SQL；
3. 已生成并审查 `0000_initial_p0_schema`；后续所有变更使用新的增量迁移；
4. 已在空库执行首份迁移并完成表、扩展、向量列、trigger 的 schema smoke test；下一步再加入 seed；
5. 使用测试数据库重复运行迁移，验证不会出现第二套 Alembic 迁移或 `updated_at` 漏更新。

Seed 必须包含：一名测试用户（仅测试环境）、Python 基础受控来源、至少一份文档、若干分块、对应 embedding、10–20 题前测与 5–10 题路线后测的单选题模板、隐藏答案和确定性评分 fixture、可运行 Demo golden case、检索 golden set。真实用户密码和 Provider Key 永远不进入 seed 文件。

### 步骤 5：完成认证与会话，再开始私有业务 API

认证实现的最小顺序：

1. `register`：规范化 email，做 Zod 校验和限流，以 Argon2id 哈希密码后仅插入 `users`；不创建 `auth_sessions`，不返回 Cookie；
2. `login`：按 email 取用户，使用恒定时间的 Argon2 验证；成功后创建新 Session，更新 `last_login_at`；失败时统一返回 `401 INVALID_CREDENTIALS`；
3. `session`：每个请求从 Cookie 取 token 后 hash，查询未撤销且未过期 Session。初始闲置有效期为 3 天，绝对上限为 `created_at + 15 天`；仅当剩余有效期不足 24 小时且距 `last_seen_at` 超过 12 小时时，将 `expires_at` 延长为 `min(now + 3 天, created_at + 15 天)`，并更新 `last_seen_at`，避免每个 GET 都写库；
4. `logout`：在事务中设置 `revoked_at`，清除 Cookie；
5. `require_current_user()`：Route Handler 的唯一认证入口；所有后续 use case 只接收已鉴权的 `user_id`，不能相信客户端 body 中的 `owner_id`；
6. 添加每天清理过期/撤销 Session 和过期 idempotency key 的维护任务。

Argon2id 的参数从 OWASP 建议的最低基线起步：内存约 19 MiB、迭代次数 2、并行度 1；在部署规格上压测后只能向更安全或可承受的方向调整。认证限流的共享状态只放 Redis，业务数据与 Session 事实源仍是 PostgreSQL。生产 Cookie 必须带 `Secure`；跨站写请求要开启 CSRF 防护。

### 步骤 6：实现核心领域用例与 Outbox

按以下顺序交付，每完成一项都增加单元测试和 repository integration test：

1. Profile：创建/更新画像、版本递增；
2. Goal：创建 Python 目标、检查画像已经完成、状态流转；
3. Assessment：创建前测/路线后测容器；前测校验 10–20 题及 `normal`/`hard`，后测校验 5–10 题及 `plan_id`；仅写入单选题，服务端按隐藏答案确定性评分且不外泄；
4. Planning：创建路线请求、DAG 验证、激活一条版本、节点解锁策略；
5. Content：创建卡片内容请求、内容版本、引用校验；实战/调试卡必须保存 AI Demo、调用顺序、注释结果与预运行验证摘要；
6. Practice：创建独立 CodeRun、只接受允许的 runtime 和长度受限的代码；请求必须携带学习卡片上下文的 `goal_id + plan_node_id`；为 AI Demo 提供发布前预运行验证；
7. Shared：在同一事务写 Outbox 与 IdempotencyKey，确保失败回滚时两者都不残留。

在此阶段 Worker 先接 `FakeModelGateway`，使“前测出题 → 路线 → 内容/Demo → 后测出题”的 API 流可以稳定自动化测试，不消耗任何真实 Provider 额度。

### 步骤 7：实现 ModelGateway 与 OpenAI-compatible Provider Adapter

P0 的**生成模型**由用户配置 OpenAI-compatible 连接（例如支持该协议的 DeepSeek、Qwen 等）；Embedding 仍固定为一个平台 Profile。先定义稳定 port，再接 OpenAI-compatible Adapter：

```text
LangGraph workflow
  → ModelGateway.generate(task_role, input, budget, model_connection_id?)
  → LLM Port / Embedding Port
  → OpenAICompatibleAdapter（LangChain integration）
  → 用户已配置的 Base URL
```

`ModelGateway` 解析模型的优先级为：**任务级显式选择** → **学习目标 `model_connection_id`** → **账户默认连接**。每个 AgentRun 固化连接 ID 与请求模型名；即使之后修改默认连接，历史任务也不会被静默改写。删除连接后关联外键设为 `NULL`，历史记录保留模型名称与运行摘要，但不会保留 API Key。

ModelGateway 至少维护以下任务规则；其中模型连接可由用户覆盖，预算、结构化 schema、超时和重试策略仍由平台控制：

| `task_role` | Profile 内容 | P0 规则 |
| --- | --- | --- |
| `assessment_generate` | 用户选择的模型连接、最大输出 token、超时、单选题 schema | 前测 10–20 题或后测 5–10 题；可任务级切换模型；校验题量、难度和至少两个选项；失败走受控题库。 |
| `plan_generate` | 目标/账户默认模型连接、预算、路线 schema、重试次数 | 创建目标时可覆盖账户默认；必须通过四阶段/DAG 校验。 |
| `card_content_generate` | 用户选择的模型连接、预算、引用与 Demo schema | AI Demo 生成可任务级切换模型；只使用 RetrieverPort 返回的受控资料，实战/调试 Demo 必须经 Runner 预运行成功。 |
| `embedding` | 固定模型、维度、版本 | 和迁移/健康检查/检索集完全一致。 |

单选作答始终是不可信输入：服务端只将其与隐藏答案比较，不将其拼入模型提示词、工具调用或检索请求。评分器必须校验选项属于当前题目，且只接受符合 Pydantic `AssessmentGrade` schema 的确定性结果。

推荐环境变量形状：

```dotenv
# 数据库和内部通信
POSTGRES_DB=learncraft
POSTGRES_USER=learncraft
POSTGRES_PASSWORD=change-me-locally
WEB_DATABASE_URL=postgresql://learncraft:change-me-locally@postgres:5432/learncraft
AGENT_DATABASE_URL=postgresql+asyncpg://learncraft_agent:change-me-locally@postgres:5432/learncraft?options=-csearch_path%3Dagent,public
INTERNAL_SERVICE_SECRET=replace-with-a-long-random-secret

# 用户模型凭据的加密主密钥：只写本机 .env / Secret Manager，不提交 .env.example。
# 值为 Base64 编码的 32 字节随机值；Web 与执行模型调用的 Worker 均需持有同一版本。
CREDENTIAL_ENCRYPTION_KEY=
CREDENTIAL_ENCRYPTION_KEY_VERSION=local-v1
LLM_GENERATION_TIMEOUT_SECONDS=45
LLM_GENERATION_MAX_OUTPUT_TOKENS=3000
ASSESSMENT_AI_MIN_CONFIDENCE=0.70
EMBEDDING_PROVIDER=SiliconFlow
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIMENSION=1024
EMBEDDING_METRIC=cosine
EMBEDDING_PROFILE_VERSION=siliconflow-bge-m3-v1
SILICONFLOW_API_KEY=
MODEL_RUN_MAX_COST_USD=0.05
```

用户自行选择生成 Provider 时，界面必须清晰展示连接名、Base URL 和模型名，但 API 响应永远不返回 API Key 密文、IV、认证标签或主密钥。先通过 Fake Adapter 的单元/契约测试，再在 staging 用一条真实测试目标做 smoke test。P0 仅对 Base URL 做格式校验，尚未发起校验请求；**在允许 Worker 对任意用户 Base URL 出网前，P1 必须实现受控出网与 SSRF 防护**：仅允许 HTTPS/批准端口、拒绝 loopback/私网/link-local/云 metadata 地址、DNS 解析后复核与防重绑定、重定向逐跳复核、审计和限流。

### 步骤 8：加入 Docker Compose（本地一键联调）

`infra/compose.yaml` 的基线如下。镜像 tag 应在真正创建仓库时锁定为具体小版本或 digest；示例中的 `pg16` 只表达兼容的主版本。

```yaml
name: learncraft

services:
  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-learncraft}
      POSTGRES_USER: ${POSTGRES_USER:-learncraft}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 5s
      timeout: 3s
      retries: 20
    networks: [private]

  minio:
    image: minio/minio:latest # 创建项目时改为锁定 tag/digest
    command: server /data --console-address ":9001"
    restart: unless-stopped
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-learncraft-minio}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD in .env}
    volumes:
      - minio-data:/data
    networks: [private]

  web:
    build:
      context: ..
      dockerfile: infra/docker/web.Dockerfile
    env_file: ../.env
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://${POSTGRES_USER:-learncraft}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-learncraft}
      AGENT_INTERNAL_URL: http://agent-worker:8000
      SESSION_COOKIE_SECURE: "false" # 生产改为 true，且只经 HTTPS 访问
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "127.0.0.1:${WEB_PORT:-3000}:3000"
    networks: [edge, private]

  agent-worker:
    build:
      context: ..
      dockerfile: infra/docker/agent-worker.Dockerfile
    command: uv run learncraft-agent worker
    env_file: ../.env
    environment:
      CORE_INTERNAL_BASE_URL: http://web:3000/internal/v1
      AGENT_DATABASE_URL: postgresql+asyncpg://${POSTGRES_USER:-learncraft}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-learncraft}
      DB_SEARCH_PATH: agent,public
      LLM_PROVIDER_MODE: ${LLM_PROVIDER_MODE:-fake}
    depends_on:
      postgres:
        condition: service_healthy
    # 不映射端口；health 仅供 private 网络中的服务探测。
    networks: [private, egress]

  code-runner:
    build:
      context: ..
      dockerfile: infra/docker/code-runner.Dockerfile
    restart: unless-stopped
    env_file: ../.env
    environment:
      RUNNER_SHARED_SECRET: ${RUNNER_SHARED_SECRET:?set RUNNER_SHARED_SECRET in .env}
      RUNNER_DEFAULT_RUNTIME: python-3.11
      RUNNER_MAX_WALL_SECONDS: "5"
      RUNNER_MAX_OUTPUT_BYTES: "65536"
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    pids_limit: 128
    mem_limit: 512m
    networks: [private]

  migrate:
    build:
      context: ..
      dockerfile: infra/docker/web.Dockerfile
    command: pnpm db:migrate
    env_file: ../.env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-learncraft}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-learncraft}
    depends_on:
      postgres:
        condition: service_healthy
    profiles: [tools]
    networks: [private]

  swagger-ui:
    image: swaggerapi/swagger-ui:latest # 创建项目时改为锁定 tag/digest
    environment:
      SWAGGER_JSON: /usr/share/nginx/html/core.yaml
    volumes:
      - ../packages/contracts/openapi/core.yaml:/usr/share/nginx/html/core.yaml:ro
    ports:
      - "127.0.0.1:${SWAGGER_PORT:-8081}:8080"
    profiles: [docs]
    networks: [edge]

volumes:
  postgres-data:
  minio-data:

networks:
  edge: {}
  private:
    internal: true
  egress: {}
```

这份 Compose 的安全和网络含义：

- 只把 Web 和 Swagger UI 绑定到本机环回地址；PostgreSQL、MinIO、Worker、Runner 不发布端口；生产则由反向代理公开 Web。
- `agent-worker` 额外挂载 `egress`，仅用于 HTTPS 调用托管模型 API；Runner 没有 egress，也不持有数据库或 Provider Key。
- `code-runner` 的 Compose 配置只是第二层限制。**绝不**把 Docker socket、宿主机目录、云凭据或数据库 URL 传给它。真正运行用户代码的子进程/一次性容器仍必须再设置无网络、非 root、cgroup 限制、超时、文件大小限制和 seccomp/AppArmor/gVisor 等隔离。
- `swagger-ui` 使用 `docs` profile，解决 Next.js 不会像 FastAPI 那样自动生成 Swagger UI 的问题：OpenAPI 是契约文件，Swagger UI 只是它的本地/测试环境展示器。

初始化与启动顺序：

```powershell
Copy-Item .env.example .env
# 编辑 .env：本地强密码、RUNNER_SHARED_SECRET、LLM_PROVIDER_MODE=fake

docker compose -f infra/compose.yaml up --build -d postgres minio web agent-worker code-runner
docker compose -f infra/compose.yaml --profile tools run --rm migrate
docker compose -f infra/compose.yaml --profile docs up -d swagger-ui

docker compose -f infra/compose.yaml ps
docker compose -f infra/compose.yaml logs -f web agent-worker
```

第一次真实 Provider 联调前，在被 Git 忽略的 `infra/.env` 或部署 Secret Manager 中写入 `CREDENTIAL_ENCRYPTION_KEY`，再通过已登录用户的模型连接 API 保存测试连接。`.env.example` 始终只保留空值/占位符；用户 API Key 不应成为 Compose 环境变量、Celery 消息或日志字段。

### 步骤 9：实现 Worker、检索和 Runner 的最小可用闭环

按以下顺序替换 Fake 组件；每完成一个仍保留 Fake 实现用于测试：

1. `OutboxRepository`：领取、锁定、重试、死信状态；
2. `AgentRunRepository`：保存运行、事件、重试次数、预算和 trace；
3. `RetrieverPort`：先读已审核种子内容，分别经 `VectorStore` 做 dense 召回、经词法检索端口做 FTS 召回，再由 `HybridRetriever` 用 RRF 融合，返回可引用定位；P0 注入 `PgvectorVectorStore`，未来可替换为 `MilvusVectorStore`。若 Provider 可返回 sparse 向量，再增加一次 `VectorStore` sparse 召回；
4. `PlanGraph`：输入规范化 → 生成 → Pydantic schema → 四阶段/DAG/时长校验 → Internal Core API；
5. `CardContentGraph`：检索、生成、引用校验；对实战/调试节点执行 Demo schema → Runner 预运行 → 预期输出比对 → 失败修复/模板兜底后回写；`AssessmentGraph`：按指定题量生成单选前测或路线后测，评分仍在 Web 侧确定性完成；
6. `RunnerClient`：CodeRun 是独立 HTTP 用例，Web 通过受限协议调用 Runner，Runner 只返回结构化结果；AI Demo 生成可使用轻量 AgentRun，但实际运行不属于 LangGraph 工作流；
7. `AdaptationPolicy`：用纯 TypeScript 领域规则消费评分和 CodeRun 结果，产生 `adaptation_events`，不要让 LLM 决定解锁权限。

### 步骤 10：完成 Swagger、日志和可观察性

1. 在 CI 中检查 `core.yaml` 有效性、生成 client/type 不产生未提交变更；
2. 本地打开 `http://localhost:8081` 验证 Swagger UI，可带 Cookie 手工测试 Web API；
3. 每个请求创建/透传 `trace_id`，日志采用 JSON；字段至少包含 `trace_id`、`agent_run_id`、任务类型、耗时、状态、模型 profile、token/费用估算；
4. 默认不记录密码、Session、API Key、完整 prompt、正确答案、用户完整代码或私密资料；
5. Worker 的 `/health` 分为 liveness/readiness：readiness 检查数据库、必需 profile 和 Core API 连通性，但不发起真实模型请求。

### 步骤 11：联调顺序（每一步有可观察证据）

先用 Fake Provider 跑完，再只在 staging 运行真实 Provider。推荐的联调剧本如下：

| 顺序 | 操作 | 必须观察到的证据 |
| --- | --- | --- |
| 1 | `docker compose up` 后执行 migration/seed | PostgreSQL 有 `public`、`agent` schema；23 张应用表、vector extension、健康检查均成功。 |
| 2 | 注册并登录测试用户 | `users.password_hash` 不是明文；浏览器仅有 HttpOnly Cookie；`GET /auth/me` 成功。 |
| 3 | 写画像、创建目标 | 数据行 `owner_id` 正确；重复 Idempotency-Key 返回同一 Goal。 |
| 4 | 请求前测 | Assessment/AgentRun/Outbox 状态由 `generating/queued` 变为 `ready/succeeded`；用户选定 10–20 题、仅有单选题、难度符合 `normal`/`hard` 与逐步提升规则；事件序号连续。 |
| 5 | 提交答案 | Attempt 只产生一条；服务端确定性评分可追踪；浏览器响应没有 `answer_key_json`；评分完成后进入 `planning`。 |
| 6 | 等待路线生成 | Plan 有 6–12 节点、四阶段、无环依赖；首节点为 `available`；模型输出校验失败时走模板/失败态。 |
| 7 | 请求实战/调试卡内容 | `card_contents` 和 `card_content_references` 同时存在；Demo 已预运行成功，调用顺序/注释结果与 stdout 一致，每个引用可定位到种子资料。 |
| 8 | 运行正常、超时、恶意三段代码 | 分别得到 succeeded、timeout、rejected/failed；Runner 无网络、无宿主路径泄露且资源被回收。 |
| 9 | 完成路线并提交后测 | 用户选择 5–10 道单选后测（推荐 5–8）；80%、60%、40% 三组确定性结果分别验证掌握、复习、下一路线补强建议，且审计事件包含触发依据。 |
| 10 | 用户 B 访问用户 A 的所有资源 | 一律 `404`；日志有 trace，不泄露 A 的标题、状态或内容。 |
| 11 | 保存测试模型连接并做一次真实 Provider smoke | 数据库记录连接 ID、请求模型名、实际模型版本/费用；Key 不出现在响应、日志、Celery 消息或容器 inspect 输出。 |

### 步骤 12：测试与 CI 最小门槛

| 层级 | 运行位置 | P0 必测内容 |
| --- | --- | --- |
| Unit | Node/Python 进程 | 领域状态机、DAG、单选题确定性评分、题量/难度边界、适应策略、预算策略、Zod/Pydantic schema。 |
| Repository integration | 临时 PostgreSQL + pgvector | 迁移、trigger、约束、owner filter、Outbox 锁、向量/FTS 检索。 |
| Contract | Web 与 Worker | `core.yaml` 生成物、单选题合同、确定性评分、RunnableDemoSpec、internal 请求/响应、事件 JSON Schema。 |
| E2E | Compose + Fake Provider | 注册到路线、已验证 Demo、独立 CodeRun、前测与路线后测、建议的完整闭环。 |
| Security regression | Compose/staging | 越权、会话撤销、限流、隐藏答案泄露、Runner 断网/资源耗尽。 |
| Staging smoke | 真实 Provider | 一条固定目标、固定资料、成本上限内的真实模型与 embedding 调用。 |

合并前最低 CI 流水线：`lint → typecheck → unit → migration on empty DB → repository integration → contract → E2E(fake provider) → image build/scan`。真实 Provider smoke 不放在每个 Pull Request 中，改为受保护环境的定时/发布前任务，并设单次费用上限。

---

## 8. P0 验收标准与验收清单

### 8.1 发布阻断验收标准

| 维度 | P0 必须满足 | 不满足时的处理 |
| --- | --- | --- |
| 主闭环 | 新用户可从注册到完成至少一张学习卡的测验/代码实践；路线由前测结果生成。 | 不发布；不能用截图或手工改库代替。 |
| 路线质量 | 每条激活路线 6–12 节点、覆盖四阶段、无环、节点状态合法。 | 阻断该路线激活，回退模板或提示重试。 |
| 内容可信度 | 卡片中的来源引用可映射到受控资料；模型推断显式标记。 | 不展示无效/伪造引用内容。 |
| 测验确定性评分 | 前测 10–20 题、后测 5–10 题均为单选题；题量与范围受数据库约束，评分只使用隐藏答案且公开响应不泄露答案。 | 保留作答并提示重试，不猜测性给分。 |
| Demo 完整性 | 实战/调试卡的 AI Demo 已在 Runner 成功预运行；调用顺序、注释结果和实际输出可对应。 | 不展示为“可运行 Demo”，改走修复/模板或失败态。 |
| 用户隔离 | 越权访问所有私有资源均为 `404`；owner filter 有 repository test。 | 最高优先级安全缺陷，禁止上线。 |
| 密码与会话 | 密码仅 Argon2id 哈希；Session token 仅以哈希入库；Cookie 安全属性符合环境。 | 禁止上线。 |
| Agent 可靠性 | 所有长任务有 AgentRun、幂等键、错误分类、状态查询；失败不静默。 | 降级模板或禁用相应入口。 |
| 模型密钥 | `CREDENTIAL_ENCRYPTION_KEY` 仅在 Web/Worker Secret；用户 API Key 仅以 AES-256-GCM 密文、IV、认证标签和版本入库，不出现在 Git、浏览器响应、日志、Celery 消息或 Runner。 | 立即轮换受影响用户 Key 与主密钥并阻断发布。 |
| 代码安全 | Runner 的无网络、非 root、资源限制、临时空间和逃逸回归测试通过。 | 先关闭在线执行，只上线静态代码示例。 |
| 数据库 | 空库可完整迁移/seed；迁移可重复检查；只有 Drizzle 一条迁移路径。 | 修复迁移，不允许人工补表。 |
| 可观察性 | 任意用户请求可从 `trace_id` 追到 Web、Outbox、AgentRun 和 Runner/Provider 摘要。 | 不发布涉及异步模型任务的能力。 |

### 8.2 手工验收清单

#### 账号与权限

- [ ] 使用新邮箱注册成功，重复邮箱返回 `409`。
- [ ] 错误密码、已撤销 Session、过期 Session 都返回统一 `401`。
- [ ] 登录响应及浏览器存储中没有 JWT、密码、哈希或原始 Session token。
- [ ] Cookie 标志在本地/生产分别符合 `SESSION_COOKIE_SECURE` 配置。
- [ ] 使用两个浏览器 Session 验证 A 无法读取或猜测 B 的 Goal、Plan、Assessment、CodeRun、AgentRun。
- [ ] 注册/登录被连续错误请求时触发限流，密码不出现在日志。

#### 学习闭环

- [ ] 填完画像后，能够创建 `python-311-basics` 目标；不支持主题被 `422` 拒绝。
- [ ] 前测由用户选择 10–20 题且只有单选题；“正常/困难”难度正确生效，题序逐步提高难度；提交前无法通过 API 拿到正确答案。
- [ ] 完成路线后，后测由用户选择 5–10 题（推荐 5–8）且只有单选题；服务端确定性评分返回分数、反馈和薄弱点，不泄露答案。
- [ ] 前测完成后生成一条四阶段、6–12 节点的路线，首节点为 `available`。
- [ ] 点击首节点后能看到目标、解释、示例、练习、提示和资料引用；实战/调试节点另有已验证的 AI Demo、调用顺序和逐步注释结果。
- [ ] 每条资料引用可点击或展示来源 URL/定位；失效来源不会被标记为已验证。
- [ ] 已验证 Demo 的调用顺序、注释结果、预期 stdout 与 Runner 实际 stdout 一致；成功代码、语法错误代码、超时代码的结果和用户文案均正确。
- [ ] 路线后测 80%、60%、40% 的确定性结果分别触发掌握、复习、下一路线补强建议，且 `adaptation_events` 留有证据。

#### Agent、模型与检索

- [ ] 每项异步操作立即返回可查询的 `agent_run_id`，页面有 queued/running/succeeded/failed 状态。
- [ ] Fake Provider 能完成所有 E2E；没有 Key 时本地启动不失败。
- [ ] 模型连接列表、创建、更新、删除和设为默认接口均只返回安全摘要；缺少加密主密钥时创建/更新返回 503，不允许明文降级。
- [ ] staging 的真实 Provider smoke 不超过设定 token/金额/超时预算；在 P1 SSRF 受控出网完成前，不对任意 Base URL 启用 Worker 实际调用。
- [ ] `agent_runs` 记录连接 ID、请求/实际模型版本、token、估算费用、重试和错误类别，不记录 API Key/完整 prompt。
- [ ] 检索结果在 seed golden set 上达到团队设定的最低 `recall@k` 与引用正确率，并保留评测结果。
- [ ] P0 不存在 HNSW 索引；达到压测门槛前不以“感觉慢”为由过早优化。

#### 数据库、容器与可恢复性

- [ ] 全新 Docker volume 上 `migrate → seed → E2E` 一次成功。
- [ ] 重复相同 Idempotency-Key 的建目标、生成路线、生成内容、代码运行不创建重复资源。
- [ ] `updated_at` 通过数据库 trigger 更新；应用遗漏更新字段时测试能发现。
- [ ] PostgreSQL、MinIO、Worker、Runner 均没有公网端口映射；只有 Web/Swagger 绑定 `127.0.0.1`（本地）。
- [ ] 断开模型 API、停止 Worker、重启 Web 三种故障下，用户看到安全失败态并可重试；已完成数据不丢失。
- [ ] Runner 未挂载 Docker socket、宿主目录或云凭据；恶意网络/资源耗尽样例被拒绝或终止。

### 8.3 P0 Definition of Done

P0 只有在以下条件同时满足时才算完成：

1. 第 2 节所有“暂时需要做”的需求均有实现、测试和演示证据；
2. 第 3 节 23 张应用表、扩展、迁移、seed、trigger 与备份/恢复演练可复现；
3. 第 4 节公开 API 均进入 OpenAPI，并通过至少一条契约测试；
4. 第 5 节三个核心流程可在 Compose 环境从 UI 跑通；
5. 第 7 节的 Fake Provider E2E 与 staging 真实 Provider smoke 都通过；
6. 第 8.1 的安全、隔离、Runner 与密钥门槛没有遗留 P0 级问题；
7. README 写明一次启动、迁移、seed、测试、停止和清理数据的命令。

---

## 9. 开工前仅剩的两个配置决策

已锁定的 Embedding Profile 为 `SiliconFlow / BAAI/bge-m3 / 1024 / cosine / siliconflow-bge-m3-v1`；真实 API Key 仅写入本机 `.env` 或 Secret Manager。现在不需要再等待模型或向量维度决策；创建 `0005_content_and_pgvector` 时必须使用 `vector(1024)`。

其余需要在对应实现前确认的决策如下：

| 决策 | 建议的 P0 做法 | 影响点 |
| --- | --- | --- |
| Runner 隔离实现 | 本地可先用受限子进程/一次性容器验证；生产必须采用经逃逸测试的强隔离方案。 | 是否能安全启用在线运行。 |
| 首个部署域名/HTTPS | staging 和 production 使用不同 Secret 与 Cookie 配置。 | Cookie `Secure`、CORS/CSRF、反向代理、回调 URL。 |

其余选择已经在本文固定：Next.js + Python Worker、PostgreSQL + pgvector、Drizzle 单一迁移、邮箱密码 Session、Docker Compose、无本地模型、用户自带 OpenAI-compatible 生成模型连接、固定平台 Embedding Profile。

## 10. 实施参考

- [Next.js App Router 安装文档](https://nextjs.org/docs/app/getting-started/installation)：当前 Node.js 要求与 `create-next-app` 选项。
- [Docker Compose profiles](https://docs.docker.com/reference/compose-file/profiles/)：将 Swagger UI、迁移等开发工具置于可选 profile。
- [pgvector 官方文档](https://github.com/pgvector/pgvector)：精确近邻查询、HNSW 与 IVFFlat 的取舍和索引语法。
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)：Argon2id 密码存储建议。
