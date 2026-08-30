# LearnCraft MVP P0 实施需求与开发指南
> **当前范围决策更新（2026-08-24，优先于后文所有 P0 描述）：**
>
> - 路线由 6–12 个主题节点组成；在实现 `plan_generate` 前，必须通过新的 Drizzle 增量迁移移除 `plan_nodes.phase` 的四阶段语义，并补齐路线快照与 `node_brief`。
> - 学习规划 Agent 负责同一 `goal_id` 逻辑会话中的前测与路线生成；节点教学 Agent 负责同一 `plan_node_id` 逻辑会话中的节点内容与用户主动触发的后测。P0 中 `assessment_generate` 专指前测生成，`posttest_generate` 专指节点后测生成。
> - 节点内容固定为 `foundation`、`worked_example`、`pitfalls_debug`；前端决定单页、分节或分页，模型不生成页面编号。
> - `worked_example` 只展示代码、调用顺序、预期输出和解释；P0 不再要求本地运行、文件清单、依赖安装或运行命令。
> - 用户阅读后主动标记已学完，并自行选择是否生成节点后测；后测不自动生成。
> - 前测、路线和节点内容的首轮/修复阶段允许模型自主调用 Tavily；节点后测只基于已固定的 CardContent 与 teaching_memory，不向外部工具发送专属内容。只有最终校验通过的结果才对用户展示，内部失败、工具调用和错误原因写入 AgentRun 日志。
>
> 本更新取代后文关于四阶段节点、`LocalDemoSpec`、本地 Demo 与自动节点后测的旧约定；在线执行仍不属于 P0。

> ## 当前范围决策（2026-08-16，优先级最高）
>
> P0 不执行任何用户或模型代码，不增加 `code-runner` 服务，也不实现浏览器在线编辑器。P0 Demo 仅为可复制到本地运行的代码产物，必须含中文注释、入口、依赖与运行步骤、预期输出、调用顺序和常见报错排查。在线 Sandbox、执行日志、stdout/stderr、资源限额与隔离测试全部后置 P1。
>
> P0 的产品主线为：用户可以维护一份当前学习画像并创建多个目标；每个目标只有一份有效前测，题集生成失败或取消且尚未得到题集时才可重试；前测提交并评分后，先向本人展示结果，只有用户点击“生成学习计划”时，模型才基于目标、题目、作答、分数、薄弱点和当前画像生成学习计划。用户可任选计划节点，不受线性解锁限制；P0 优先完成一个节点的内容与本地 Demo → 标记完成 → 节点后测 → 评分 → 可重新生成后测练习闭环。
>
> 画像只保留一份当前记录。新目标和未生成内容使用最新画像；前测、学习计划和已生成内容保存 `profile_version` 与必要输入快照，不因后续画像编辑而改写。P0 提供目标列表与目标详情；每个目标只显示最新前测，历史数据保留但不提供历史 UI。

> 版本：v0.3（范围已确认）
> 日期：2026-08-16
> 配套文档：[技术栈选型](./01-技术栈选型.md) · [DDD 项目目录](./02-DDD项目目录.md) · [MVP PRD](./03-MVP-PRD.md)

## 1. 文档目的、P0 边界与已锁定决策

本文把产品 PRD 进一步落成一个人可以按顺序实现、联调和验收的 **P0 开发基线**。它不替代前三份文档：

- `01` 说明为什么选择 A 架构；
- `02` 说明领域边界和目录依赖；
- `03` 说明产品目标和完整 MVP 范围；
- **本文**定义 P0 具体要做什么、怎样建表、接口长什么样，以及从零开始的实现顺序。

### 1.1 P0 的一句话目标

一位用户能够注册登录，维护一份当前学习画像并创建多个程序员学习目标；每个目标完成一次前测并查看答案、解析和分数后，自主决定是否生成“概念 → 语法 → 实战 → 调试”学习路线；可任选节点取得唯一的带来源学习内容与本地代码 Demo，标记完成后反复生成独立后测题集、查看历史错题解析，并获得掌握、复习或提高难度建议。

### 1.2 P0 产品与技术边界

| 项目 | P0 固定范围 | 原因 |
| --- | --- | --- |
| 学习主题 | 用户自由填写面向程序员的技术主题，中文桌面端 | 先验证主题输入、前测与路线闭环；P0 不承诺任何语言的在线运行环境。 |
| 学习目标 | 用户可创建多个目标；每个目标一条当前激活路线；路线 6–12 个节点 | 支持并行目标，避免路线编辑器。 |
| 前测与节点后测 | 前测由用户选择 10–20 题（默认推荐 12 题），节点后测由用户选择 5–10 题（推荐 5–8 题）；均为单选题 | 提交后可立即确定性评分；前测提供“正常/困难”卡片且按题序逐步提高难度。 |
| 知识来源 | 内置、人工审核的官方文档/视频链接和种子文档 | P0 不允许用户上传 PDF、任意 URL 抓取或 MinerU 解析。 |
| 检索 | PostgreSQL FTS + pgvector 余弦精确检索；返回可追溯引用 | 小规模内容先获得确定性和易维护性；压测后才加 HNSW。 |
| 本地代码 Demo | 实战/调试节点生成可复制到本地运行的代码、说明和调用顺序；P0 不执行任何用户或模型代码 | 保持 Demo 的学习价值，同时不把在线执行高风险能力带入 P0。 |
| 模型 | 用户自带公网 OpenAI-compatible 生成连接 + 一个固定 embedding Profile；P0 Worker 只解析账户默认连接 | 不部署 vLLM/Ollama；用户承担生成 Provider 费用，平台免费提供学习流程、检索与本地 Demo。产品永久不支持 IP 字面量、localhost、局域网、私有地址或本地 vLLM；真实调用固定经受控出网层。 |
| 异步任务 | 规划、内容/Demo 生成和自动出题通过 `AgentRun` 异步执行；单选题评分同步完成 | 模型调用有延迟和失败，需要可重试、可观察、可恢复；确定性评分不需要排队。 |

### 1.3 P0 已作出的实现决策

1. **架构：**Next.js App Router 负责 UI、BFF、认证与核心学习领域；Python FastAPI + LangGraph 在同一 Worker 内实现学习规划 Agent 与节点教学 Agent 两个职责隔离的工作流，负责模型调用、检索和受控工具。Python 不复制学习路线、题目等业务聚合，也不维护无限原始聊天记录。
2. **认证：**P0 使用“邮箱 + 密码 + 数据库不透明 Session + HttpOnly Cookie”。密码用 Argon2id 哈希；浏览器不接收 JWT。这样本地开发不依赖 OAuth 或邮件供应商，也不会把长期令牌暴露给前端。OAuth、Magic Link、找回密码和移动端 Token 放 P1。
3. **迁移所有权：**`db/migrations/` 中的 Drizzle 迁移是 P0 唯一建表入口。`apps/agent-worker/alembic/` 保留说明文件，但 **P0 不执行 Alembic**，否则会出现两个迁移工具竞争同一数据库的问题。
4. **用户模型连接：**`ModelGateway` 是 `agent-worker` 内的应用服务，不是 Docker 容器。用户只可保存公网 OpenAI-compatible Base URL、API Key 和模型名，永久不支持 localhost、局域网、私有 IP 或本地 vLLM；Key 由 Web 以 AES-256-GCM 加密持久化，浏览器只可写入/覆盖，Outbox、日志和 AgentRun 仅记录连接 ID/模型名。`CREDENTIAL_ENCRYPTION_KEY` 只进入 Web 与 Worker 的 Secret/环境变量。
5. **向量索引：**P0 先不建 ANN 索引。固定 embedding Profile、内容量和检索评测集后，只有在检索 p95 或数据量达到阈值时，才用 HNSW 作为首个 ANN 方案；不引入独立向量数据库。
6. **在线代码执行：**P0 不创建 `CodeRun` API、不启动 Runner 容器、不提供浏览器编辑器或 stdout/stderr。当前数据库中已存在的 `code_runs` 物理表只作为 P1 预留，不是 P0 功能契约；P1 再确认沙箱隔离、语言、资源限制和成本模型后才启用。
7. **双 Agent 与内部参数：**P0 的学习规划 Agent（每 Goal 一个逻辑会话）负责前测与计划；节点教学 Agent（每 PlanNode 一个逻辑会话）负责唯一内容/Demo 与后测。二者只通过版本化结构化快照交接。用户只选择账户默认模型；开发者通过 Worker 内部版本化 `AgentExecutionProfile` 配置各 Agent 的提示词、Schema、Token、超时、工具权限、重试和思考模式，不提供管理员或用户参数配置页面。

### 1.4 P0 明确不做

- 社区、社群、评论、关注、排行榜、成就、全局学习进度条、学习报告；
- 多课程、多编程语言、任意文件/网页导入、视频转写、自动抓取互联网；
- 本地模型、vLLM、Ollama、自动的跨 Provider 费用优化或平台代付生成费用；
- 多租户组织、付费订阅、管理员后台、人工教师批改；
- 多人协作、通用聊天助手、长期记忆、自动向外部系统发布；
- 浏览器代码编辑、任意 `pip install`、网络访问、持久磁盘、GPU 或长任务代码执行。

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
| P0-PROFILE-001 | 首次进入时创建唯一的当前学习画像。 | 收集整体编程经验、学习背景、每周可投入时间和内容偏好；不填写与具体主题重复的起始水平；刷新后资料仍存在。 |
| P0-PROFILE-002 | 用户可创建一个自定义技术主题学习目标。 | 目标包含 1–200 字符的 `topic`、自然语言说明、期望结果、截止日期（可选）和每周时间（可选）；主题不设语言或技术栈白名单。 |
| P0-PROFILE-003 | 用户可查看和修改自己的当前画像。 | 每用户只保存一份可编辑画像；修改只影响本人数据、新目标和未生成内容；已生成前测、路线与内容保存画像版本和输入快照。 |
| P0-PROFILE-004 | 用户可查看全部学习目标及其状态。 | 可在尚未开始前测时继续创建新目标；目标列表显示标题、状态和最新前测摘要，详情页提供开始前测、创建另一个目标与查看全部目标入口。 |
| P0-PROFILE-005 | 已启动规划的目标显示明确状态。 | 状态至少可见：`draft`、`assessment_pending`、`planning`、`active`、`failed`；页面不会无提示地一直加载。 |

**暂时需要做：**自由主题表单与数据库非空校验、目标列表/详情、目标与画像版本、目标状态机、空状态和失败重试入口。

**暂时不需要做：**用户自定义课程市场、技能树编辑、学习时间日历、多个并行主题推荐、企业/班级画像。

### 2.3 前测与能力判定

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-ASSESS-001 | 为目标生成唯一的一套前测。 | 用户可选择 10–20 题，默认推荐 12 题；只包含单选题；每目标题集成功生成后禁止再次生成。 |
| P0-ASSESS-002 | 用户可以保存作答并提交前测。 | 刷新不丢答案；重复点击提交不创建两条 Attempt；提交后的答案不可直接修改。 |
| P0-ASSESS-003 | 系统自动评分并给出薄弱点标签。 | 题目首次生成时已保存隐藏答案与解析；服务端按答案确定性评分。交卷前公开题集不返回答案/解析，交卷后仅向作答用户返回正确答案、逐题解析、分数与薄弱点；不再次调用模型。 |
| P0-ASSESS-004 | 用户确认后生成学习路线。 | 评分完成后目标保持“可生成计划”状态；只有用户点击“生成学习计划”才进入 `planning` 并创建可追踪的 `plan_generate` AgentRun。 |
| P0-ASSESS-005 | 前测生成异常可恢复。 | 模型或网络错误时，首轮和修复阶段允许模型自行调用 Tavily；主流程最终校验仍不合法时强制执行 Tavily 的广搜、缩搜和资源阅读后重建题集，并再次校验。只有通过最终校验的题集才能进入 `ready/succeeded`；失败原因、工具调用和重试记录在内部，用户不接收原始生成失败结果。用户主动取消仍保留取消语义；成功得到题集后不再提供重新生成；不产生重复费用或重复题目。 |

**暂时需要做：**10–20 题单选前测、`normal`/`hard` 难度卡片、按题序逐步提高难度、确定性评分、答题幂等与隐藏答案、成功题集唯一性与失败重试规则。

**暂时不需要做：**长篇作文/开放项目报告的主观阅卷、人工批改、限时监考、题库运营后台、跨目标能力雷达图。

### 2.4 学习路线与动态调整

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-PLAN-001 | 根据画像、目标和前测生成路线。 | 用户确认后由学习规划 Agent 生成书籍章节目录式路线；路线含 6–12 个主题节点，章节顺序、主题覆盖和前置依赖合法。 |
| P0-PLAN-002 | 每个节点有可展示的学习信息。 | 节点至少含标题、自然语言 `node_brief`、目标、难度、预计分钟、前置节点、完成标准、安排理由和状态；`node_brief` 是节点教学 Agent 的主要自然语言输入。 |
| P0-PLAN-003 | 路线依赖关系合法。 | 保存前校验节点数量、章节顺序、主题覆盖、前置依赖无环和时长范围；不合法结果先进入有限修复，主流程最终校验仍失败时强制调用 Tavily MCP 重建并再次校验；未经最终校验的结果不能写入激活路线。 |
| P0-PLAN-004 | 用户能查看路线并打开任意节点。 | 路线页展示 `not_started`、`in_progress`、`completed`、`needs_review` 等状态；前置关系只用于展示和建议，不能阻止用户直接进入任意节点。 |
| P0-PLAN-005 | 节点后测结果产生显式建议。 | 节点后测 ≥80% 提示掌握；50–79% 建议复习；<50% 提示薄弱点与重新生成后测练习；不改写当前路线。 |
| P0-PLAN-006 | 高分建议有边界。 | 节点后测 100% 时，只能建议下一次内容生成选用“困难”难度；不得跳过、锁定或改写当前路线节点，页面展示理由。 |

**暂时需要做：**异步路线生成、DAG 校验、路线版本、简单可解释规则、节点状态展示和失败重试。

**暂时不需要做：**拖拽编辑路线、用户手工改依赖、复杂推荐模型、跨课程知识图谱、完整进度报表。

### 2.5 卡片内容、受控资料与检索

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-CONTENT-001 | 点击任意节点后首次生成内容卡。 | 节点教学 Agent 以目标摘要、`node_brief` 和当前画像生成并保存唯一内容；内容至少有学习目标、核心解释、示例、练习、提示、资料引用和内部 `teaching_memory`；`practice/debug` 节点额外带可复制到本地运行的 Demo、调用顺序和中文注释。 |
| P0-CONTENT-002 | 内容只使用获准来源或显式标记模型推断。 | 每个引用返回来源名称、URL、文档/页码或定位；找不到来源时不伪造引用。 |
| P0-CONTENT-003 | 检索先做权限/标签过滤，再做 FTS 和向量召回。 | 检索日志保留 `source/document/chunk` 标识与 profile 版本；UI 不直接查询 pgvector。 |
| P0-CONTENT-004 | 唯一内容与失败重试。 | 同一节点只允许一份成功 `card_contents`；成功后不提供重新生成入口。仅在尚未成功保存内容时允许重试，幂等重放返回同一运行或同一成功内容。 |
| P0-CONTENT-005 | P0 内容目录可被种子脚本初始化。 | 新环境执行 seed 后，至少有一组 Python 基础资料、分块和 embedding，可完成一次真实检索。 |

**暂时需要做：**种子来源、对象存储 URI 元数据、分块、固定 embedding、FTS、精确向量检索、引用校验、卡片内容 schema，以及实战/调试本地 Demo 的结构化合同。

**暂时不需要做：**用户上传、任意 URL 抓取、PDF/OCR/MinerU、视频转写、全文版权库、Milvus 迁移、多 embedding 版本共存。检索实现必须只依赖 `VectorStore` 抽象，P0 由 pgvector 适配器承载。

#### 实战 / 调试节点的可运行 Demo 合同

`phase = practice` 与 `phase = debug` 的 `card_contents.public_content_json` 必须包含下列字段；概念、语法节点可只提供普通示例与练习。

```json
{
  "local_demo": {
    "language": "python",
    "runtime_version": "3.11",
    "files": [
      {
        "path": "main.py",
        "content": "def greet(name):\n    # 返回欢迎语\n    return f'Hello, {name}!'\n\nprint(greet('LearnCraft'))\n"
      }
    ],
    "entry_file": "main.py",
    "dependencies": [],
    "setup_steps": ["创建虚拟环境", "安装依赖（如有）"],
    "run_command": "python main.py",
    "expected_output": "Hello, LearnCraft!"
  },
  "call_sequence": [
    { "step": 1, "symbol": "__main__", "action": "执行 print(...)" },
    { "step": 2, "symbol": "greet", "action": "接收 name 并返回格式化字符串" }
  ],
  "annotated_result": [
    { "step": 1, "code_reference": "print(greet('LearnCraft'))", "explanation": "入口调用 greet。" },
    { "step": 2, "code_reference": "return f'Hello, {name}!'", "explanation": "函数返回字符串，随后由 print 输出。" }
  ],
  "troubleshooting": [
    { "symptom": "python 命令不存在", "suggestion": "确认已安装 Python 3.11，并将其加入 PATH。" }
  ]
}
```

`debug` 节点可额外提供一个**受控故障版本**（故障位置、预期症状、诊断提示和修复后代码），但它只用于阅读与本地调试练习。P0 不在服务器运行或验证任何代码，因此不得出现 `validated_code_run_id`、`validated_at`、stdout/stderr 或类似的执行结论。

### 2.6 本地代码 Demo（P0）与在线 Sandbox（P1）

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-RUN-001 | 实战/调试节点由 AI 生成本地 Demo。 | 输出语言与版本、完整文件、入口、依赖安装、运行命令、预期输出、调用顺序、中文注释和常见报错排查；不要求或声称服务端预运行。 |
| P0-RUN-002 | 用户可复制与理解 Demo。 | 页面可复制文件内容、命令与步骤；明确提示代码需在用户本地运行；不创建 CodeRun、不提供运行 API、编辑器、stdout/stderr 或执行状态查询。 |
| P1-RUN-003 | 浏览器编辑器和受限 Sandbox。 | 在重新确认语言、依赖与隔离方案后，才支持编辑、运行、重置；执行进程必须非 root、无网络、无宿主机挂载、临时目录且有 CPU/内存/进程数/输出大小/墙钟时间限额。 |
| P1-RUN-004 | 在线运行结果与审计。 | 展示 stdout、stderr、退出码、测试摘要与耗时；保存资源用量和代码快照；不泄露主机路径、环境变量、Token 或内部异常栈。 |

**暂时需要做：**本地 Demo schema、完整文件/入口/依赖/命令字段、调用顺序、中文注释、预期输出、排错提示、页面复制体验与明确免责声明。

**暂时不需要做：**在线执行器、浏览器编辑器、任意语言运行时、服务端包安装、网络请求、文件持久化、多人共享运行环境、GPU、长任务、Notebook。

### 2.7 节点后测、完成规则与反馈

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-POST-001 | 节点内容生成后生成后测。 | 任意节点存在 ready 内容后即可选择 5–10 题，推荐 5–8 题；节点教学 Agent 仅基于该节点固定内容、Demo 与 `teaching_memory` 出单选题，plan_node_id 必填；每次重练生成独立题集。 |
| P0-POST-002 | 提交后获得评分、解析和历史错题。 | 题目首次生成时已保存答案与解析；服务端确定性评分，交卷后仅向作答用户返回总分、正确答案、逐题解析和薄弱点。节点页可查看历史后测题集、作答、错题和解析；不再次调用模型。 |
| P0-POST-003 | 节点完成条件明确。 | 节点完成由用户显式标记；后测分数不限制访问其他节点；不满足时允许复习和重新生成后测，不丢历史结果。 |
| P0-POST-004 | 后续建议可审计。 | 每一次掌握、复习或提高下一次内容生成难度的建议都记录触发证据、策略版本和结果；不修改当前路线。 |

**暂时需要做：**前测与节点后测共用的单选题和确定性评分合同、生成时一次性保存答案/解析、交卷后按所有权暴露解析、题量边界、用户完成标记（仅个人记录）、同节点后测新题集重生、历史题集/错题查看、规则驱动建议和用户可见理由。

**暂时不需要做：**完整学习报告、徽章/积分、同伴对比、复杂知识追踪算法、教师审批。

### 2.8 Agent、模型供应商与可观测性

| 需求 ID | 描述（简洁） | 验收标准 |
| --- | --- | --- |
| P0-AGENT-001 | 每项模型长任务有 AgentRun。 | 前测/节点后测出题、路线生成、内容/本地 Demo 生成都返回 `agent_run_id` 与状态；确定性评分不创建 AgentRun。 |
| P0-AGENT-002 | 两个 Agent 使用账户默认模型与内部 Profile。 | 用户可在模型设置保存 Base URL/API Key/模型名并设置账户默认连接；P0 的学习规划 Agent 和节点教学 Agent 均使用该默认连接。开发者在内部 `AgentExecutionProfile` 中分别设置提示词、输出 Schema、Token、超时、工具权限、重试和思考模式；运行记录连接 ID、模型名、Profile 版本、超时、重试、token 与费用估算。Key 不进入响应、日志、Outbox 或 AgentRun。 |
| P0-AGENT-003 | 模型输出通过结构化校验和业务校验。 | Pydantic/JSON Schema 失败可有限次重试；首轮和修复阶段模型可自行调用 Tavily，主流程最终校验仍失败时强制调用 Tavily MCP 的广搜、缩搜和资源阅读能力重建结果，并再次校验。无效路线/题目/AI 评分/Demo/引用不得写库或触发路线调整；用户不接收未经校验的原始生成结果。 |
| P0-AGENT-004 | Worker 故障可定位和恢复。 | `trace_id` 可贯穿 Web、Outbox、Worker、Tavily MCP 和模型调用；内部日志记录错误类别、可重试标识、工具调用链和安全摘要；只有已校验结果才对用户展示。 |

**暂时需要做：**OpenAI-compatible Adapter、用户模型连接设置、AES-256-GCM 凭据加密、账户默认选择、Fake Adapter、超时/预算/重试、结构化输出、AgentRun 事件、健康检查。

**暂时不需要做：**自动跨 Provider 智能路由、微调、模型网关独立服务、LangSmith 强依赖、自托管推理，以及自动发起 Provider 连通性验证。

---

## 3. 数据库设计

### 3.1 设计原则

| 原则 | 说明 |
| --- | --- |
| 原生类型优先 | ID 用 PostgreSQL `uuid`，时间用 `timestamptz`，可演进的结构才用 `jsonb`；不以 `VARCHAR(36)` 模拟 UUID。 |
| 单一事实源 | `public` 中的用户、目标、路线、题目与内容由 Next.js Core 领域服务写入；Python Worker 不绕过 Core API 修改这些表。在线代码执行是 P1 范围。 |
| Agent 独立基础设施 | `agent` schema 仅保存 AgentRun 和运行事件；它记录“如何执行”，不定义“何为合格路线”。 |
| 迁移单一所有者 | Drizzle 负责所有 schema 迁移，包括 `agent` schema 的 DDL；P0 不同时运行 Alembic。 |
| 所有权默认显式 | 每个用户私有聚合保留 `owner_id`，每个查询都按 `id + owner_id` 过滤；P0 服务层执行 ACL，P2 再评估 RLS。 |
| 状态不藏在 JSONB | 路线、节点、测验与 Agent 的关键状态使用 `varchar + CHECK`；JSONB 只存模型元数据、结构化内容或必要输入快照。 |
| 版本与唯一内容并存 | 路线、题目和 Attempt 保留版本/快照；前测、路线和已生成内容记录 `profile_version` 与必要输入快照。P0 每节点只允许一份成功内容/Demo，不能重生；节点后测每次重练创建新题集，不能覆盖历史作答或错题解析。 |
| 幂等写入 | 所有会创建费用或任务的写 API 接收 `Idempotency-Key`，并保存请求哈希与原始响应。 |
| Embedding 固定 | P0 一个数据库只接受一个固定 embedding Profile/维度。切换模型要走新迁移和完整重嵌入，不能静默混用向量维度。 |
| 敏感数据最小化 | 用户 Provider API Key 仅以 AES-256-GCM 密文、IV、认证标签和密钥版本存储；不记录明文密码、原始 session token、隐藏答案、完整 prompt 或未脱敏的模型响应。 |
| 自动更新时间 | `updated_at DEFAULT now()` 不会自动更新；所有含 `updated_at` 的表通过数据库 trigger 统一维护。 |

### 3.2 Schema、表数量与模型归属

当前物理 Schema 共 **24 张 LearnCraft 应用/基础设施表**：`public` schema 22 张，`agent` schema 2 张。P0 实际使用其中 22 张；`code_runs` 与 `adaptation_events` 为 P1 预留物理表，P0 不写入或读取它们。LangGraph PostgreSQL checkpointer 的官方表不算入这 24 张；它由锁定版本的 `langgraph-checkpoint-postgres` 官方迁移创建，不能手写一个“类似的” ORM 表替代。

| Schema | 表 | 写入所有者 | ORM/Schema 文件 | 用途 |
| --- | --- | --- | --- | --- |
| public | `users`、`auth_sessions` | Web Identity | `db/schema/identity.ts` | 邮箱密码账号和数据库 Session。 |
| public | `user_model_connections`、`model_connection_egress_audits` | Web Model Connection / Python 安全审计写入 | `db/schema/model-connection.ts`、`infrastructure/persistence/models/model_connection_egress_audit.py` | 用户自带 OpenAI-compatible Base URL、默认模型及 AES-256-GCM 加密凭据；最小出网审计保留 30 天。 |
| public | `learner_profiles` | Web Profile | `db/schema/profile.ts` | 学习者画像。 |
| public | `learning_goals`、`learning_plans`、`plan_nodes`、`plan_node_prerequisites` | Web Planning | `db/schema/planning.ts` | P0 目标、路线、节点和依赖。 |
| public | `adaptation_events` | Web Planning | `db/schema/planning.ts` | P1 预留的动态调整审计；P0 不写入。 |
| public | `assessments`、`assessment_items`、`assessment_attempts`、`assessment_answers` | Web Assessment | `db/schema/assessment.ts` | 前测、节点后测、答案与评分快照。 |
| public | `content_sources`、`content_documents`、`content_chunks`、`card_contents`、`card_content_references` | Web Content | `db/schema/content.ts` | 受控资料、FTS/向量、卡片内容/引用，以及实战/调试本地 Demo 合同。 |
| public | `code_runs` | Web Practice | `db/schema/practice.ts` | P1 预留的在线代码执行任务和结果；P0 不写入。 |
| public | `outbox_events`、`idempotency_keys` | Web Shared Infrastructure | `db/schema/integration.ts` | 可靠投递和 HTTP 写操作幂等。 |
| agent | `agent_runs`、`agent_run_events` | Python Agent Worker | `infrastructure/persistence/models/` | 编排状态与可重放运行事件。 |

> **数据库基类澄清：**Drizzle 是 TypeScript 查询/映射工具，不使用 Python 那种 `DeclarativeBase` 继承树；公共业务表用 Drizzle schema + SQL migration 定义。Python 的 SQLAlchemy `Base` 只映射 `agent_runs`、`agent_run_events` 与 Worker 写入的最小安全审计表 `model_connection_egress_audits`，不能再创建一套 `UserModel`、`LearningPlanModel` 与 Next.js 竞争。

### 3.3 表关系图

```mermaid
erDiagram
    USERS ||--|| LEARNER_PROFILES : has
    USERS ||--o{ AUTH_SESSIONS : opens
    USERS ||--o{ LEARNING_GOALS : owns
    USERS ||--o{ USER_MODEL_CONNECTIONS : configures
    USERS ||--o{ MODEL_CONNECTION_EGRESS_AUDITS : audits
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
    PLAN_NODES ||--o{ CODE_RUNS : P1_executes
    LEARNING_PLANS ||--o{ ADAPTATION_EVENTS : P1_adjusts
    USERS ||--o{ AGENT_RUNS : owns
    USER_MODEL_CONNECTIONS ||--o{ AGENT_RUNS : selected_for
    AGENT_RUNS ||--o{ AGENT_RUN_EVENTS : emits
```

### 3.4 初始化约定

下面 DDL 说明当前 Drizzle 物理迁移基线。当前空库基线已由 Drizzle 生成 `apps/web/src/lib/db/migrations/0000_initial_p0_schema.sql`，并在该文件中补充扩展、`agent` schema 与 trigger 的 raw SQL；不要把整段 SQL 在生产库手工粘贴运行。后续需求一律通过新的增量迁移实现，不重写历史文件。

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

#### 3.4.1 节点闭环实施前必须补齐的增量迁移

当前物理 Schema 已有 `learner_profiles.profile_version` 与 `learning_goals.profile_version`，但尚未为前测、路线和卡片内容完整保存画像版本与输入快照。实现 `plan_generate`、节点内容生成和节点后测前，必须新增一次 Drizzle 迁移，至少补齐：

- `assessments.profile_version` 与 `assessments.input_snapshot_json`，用于前测与节点后测的可追溯输入；节点后测还要增加 `source_card_content_id`，并约束其指向该 `plan_node_id` 的唯一成功内容；
- `learning_plans.profile_version` 与 `learning_plans.input_snapshot_json`，用于固定生成路线时的目标、前测结果和当前画像；`plan_nodes` 要增加非空 `node_brief`，它是节点教学 Agent 的自然语言输入；
- `card_contents.profile_version`、`card_contents.input_snapshot_json` 与仅供 Worker 读取的 `teaching_memory_json`，用于固定节点内容、本地 Demo 与后测出题上下文；建立“每个 `plan_node_id` 最多一条 `ready` 内容”的部分唯一索引或等效事务性规则。失败记录可保留并允许重试，但成功后不得插入第二份内容；
- 将当前 `card_quiz` 的数据库语义明确迁移为节点后测，且约束 `plan_node_id`、`source_card_content_id` 必填；前测成功生成后建立数据库唯一性约束或等效事务性规则，禁止同一目标创建第二份成功题集。节点后测不设唯一题集约束，每次重练新增 Assessment 与 Attempt 历史；
- 复用现有 `agent_runs.requested_model_profile`、`actual_model_profile`、`prompt_version`、`input_summary_json` 与 `output_summary_json`，记录由 `run_type` 派生的 Agent 角色、逻辑会话键和 `AgentExecutionProfile` 版本；不新增原始聊天消息表。

这些字段与约束是已确认的 P0 产品需求；迁移文件尚未创建。新增前必须按 Drizzle 的增量迁移规则编写，并同步更新 Zod、领域对象、OpenAPI 与 Pydantic 契约。

### 3.5 当前物理 Schema DDL（第一部分：身份、画像、规划）

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

-- 仅记录模型出网安全决策；不保存 API Key、提示词、响应正文或 DNS IP。
-- model_connection_id 不设外键，避免用户删除连接后失去保留期内的审计痕迹。
CREATE TABLE public.model_connection_egress_audits (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    model_connection_id uuid NOT NULL,
    agent_run_id        uuid,
    host                varchar(253),
    port                integer CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
    decision            varchar(20) NOT NULL
                        CHECK (decision IN ('allowed', 'blocked', 'request_failed')),
    reason_code         varchar(100) NOT NULL CHECK (length(btrim(reason_code)) > 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,
    CONSTRAINT ck_model_connection_egress_audits_expiry CHECK (expires_at > created_at)
);

CREATE INDEX idx_model_connection_egress_audits_cleanup
    ON public.model_connection_egress_audits(expires_at);
CREATE INDEX idx_model_connection_egress_audits_connection_occurred
    ON public.model_connection_egress_audits(model_connection_id, created_at DESC);

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
    topic                   varchar(200) NOT NULL
                            CHECK (length(btrim(topic)) BETWEEN 1 AND 200),
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

### 3.6 当前物理 Schema DDL（第二部分：测验、内容与 pgvector）

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

对于 `practice/debug` 卡片，`public_content_json` 保存用户可见的 `local_demo`、`call_sequence`、`annotated_result` 和 `troubleshooting`；当前物理字段 `runner_spec_json` 是历史命名，P0 仅可将其作为兼容的本地 Demo 辅助信息存储，不能保存运行时配置、验证摘要或执行输出。后续如要改名为 `local_demo_spec_json`，需另行确认并通过增量迁移完成。 `generation_metadata` 仅保存生成次数、模型/提示词/schema 版本与非敏感结构化校验结果；不得保存 `code_run_id`、内部 Runner 地址或密钥。

**向量检索决策：**检索工作流只能调用 `VectorStore` 抽象，不得出现 pgvector SQL 或 Milvus SDK。该端口可承载 dense 与 sparse 向量，但单次 `search` 只查询一种模态；`HybridRetriever` 分别获取 dense、sparse（未来）或 FTS 的排序列表，再以 RRF 融合。P0 的托管 BGE-M3 Embedding API 仅使用 dense 输出，因此以 `source_type / tag / language / verification_status` 过滤后，分别做 PostgreSQL FTS 和 `<=>` 余弦精确排序并融合即可；`tsvector` 是词法检索，不是 BGE-M3 学习型 sparse embedding。此时不建立 HNSW，导入和重嵌入更简单，也不会出现近似召回质量难以解释的问题。达到以下任一条件后，才以离线检索集压测并评审 HNSW：`content_chunks >= 50,000`、检索 p95 超过 300 ms、或精确检索已影响用户等待时间。只有当已确认的数据规模或吞吐目标仍无法由 pgvector 满足，且用户批准 backfill、双读评测、成本与回滚方案后，才实现 `MilvusVectorStore` 并切换。批准 HNSW 后执行类似以下的专用迁移（`CREATE INDEX CONCURRENTLY` 不能放在普通事务迁移中）：

```sql
CREATE INDEX CONCURRENTLY idx_content_chunks_embedding_hnsw
    ON public.content_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
```

### 3.7 当前物理 Schema DDL（第三部分：P1 预留实践、Agent 与可靠投递）

下列 `code_runs` DDL 已存在于当前物理 Schema，但不表示 P0 应实现在线执行。P0 不对该表进行读写；它保留给 P1 通过独立安全决策启用。

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
    goal_id                 uuid NOT NULL REFERENCES public.learning_goals(id) ON DELETE CASCADE,
    run_type                varchar(40) NOT NULL
                            CHECK (run_type IN (
                              'assessment_generate', 'plan_generate',
                              'card_content_generate', 'posttest_generate', 'adaptation'
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

CREATE INDEX idx_agent_runs_owner_goal_status_created
    ON agent.agent_runs(owner_id, goal_id, status, created_at DESC);

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

P0 的 `assessment_items` 仅允许 `single_choice`：题目首次生成时，`answer_key_json` 保存隐藏正确选项，`explanation`/等价解析字段保存逐题解释；服务端同步完成确定性评分，并在 `grading_metadata_json` 保存评分器与题目/答案版本标识。交卷前绝不返回答案或解析，交卷后仅题主可读取。`rubric_json` 是为避免破坏旧迁移而保留的历史兼容列，P0 不读取或写入它。节点后测的每次生成创建新的 `posttest_generate` AgentRun 和新的 Assessment；评分不创建 AgentRun。当前 `card_quiz` 命名与节点后测语义的收敛要求以 3.4.1 的增量迁移为准。

### 3.8 `updated_at` Trigger 与迁移顺序

所有包含 `updated_at` 的表必须挂触发器：`users`、`auth_sessions`、`user_model_connections`、`learner_profiles`、`learning_goals`、`learning_plans`、`plan_nodes`、`assessments`、`assessment_attempts`、`assessment_answers`、`content_sources`、`content_documents`、`card_contents`、`code_runs`、`agent.agent_runs`、`idempotency_keys`。

```sql
CREATE TRIGGER trg_users_touch_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 其余表在同一迁移中按相同模式建立 trigger；不要依赖应用代码“记得更新”。
```

当前初始库使用一个可审查的 `0000_initial_p0_schema`：其中包含 22 张历史物理表、`pgcrypto`/`citext`/`vector` 扩展、`agent` schema、索引、外键和 15 个 `updated_at` trigger，已在本地 Docker PostgreSQL 验证。`0003_user_model_connections` 以增量方式新增第 23 张表、目标/AgentRun 选择快照字段与第 16 个 trigger；`0004_learning_goal_topic` 将固定主题键改为开放 `topic` 字段；`0005_model_connection_egress_audit` 新增第 24 张表。当前 P0 范围以本章 3.4.1 的后续增量迁移为准；上线后不得重写历史迁移，所有变更必须由新的增量迁移表达。

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
| P1（物理表已预留） | `code_runs`、`adaptation_events` | 在线 Sandbox 运行记录与动态路线调整审计；P0 不读写。 |
| 已实现安全基础 | `model_connection_egress_audits` | 自定义 Base URL 的最小出网审计（允许/拒绝/请求失败），30 天保留；运行时完成 HTTPS/443、DNS/IP、固定连接与重定向防护。 |
| P1 | `model_connection_verification_events` | 用户主动触发的 Provider 连通性验证记录；不自动调用以避免产生用户费用。 |
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
| 写操作 | 除注册、登录、退出外，所有可能创建任务或生成内容的 POST 请求都必须带 `Idempotency-Key`。 |
| 异步 | 返回 `202 Accepted` 时必有 `agent_run_id`；客户端查询状态或订阅 SSE，不等待模型调用完成。 |
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

模型连接为当前账户私有资源，支持一个账户默认连接。`api_key` 是仅写字段：创建时必须提供，更新时仅在替换 Key 时提供，任何成功或失败响应都不会回传它或其密文。用户只能填写公网 HTTPS 域名且仅允许 443 端口，永久不支持任何 IP 字面量、localhost、局域网、私有地址或本地 vLLM；实际 Worker 出网必须经受控出网层。

| 方法与路径 | 用途 | 成功响应 |
| --- | --- | --- |
| `GET /api/v1/model-connections` | 列出当前用户的安全连接摘要 | `200` `{ items: ModelConnection[] }` |
| `POST /api/v1/model-connections` | 加密保存连接，可同时设为账户默认 | `201` `ModelConnection` |
| `PATCH /api/v1/model-connections/{model_connection_id}` | 修改名称、Base URL、默认模型或替换 API Key | `200` `ModelConnection` |
| `POST /api/v1/model-connections/{model_connection_id}/default` | 设置账户默认连接 | `200` `ModelConnection` |
| `DELETE /api/v1/model-connections/{model_connection_id}` | 删除连接；历史运行记录保留安全摘要 | `204` |

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
| `GET /api/v1/learner-profile` | 读取当前用户唯一画像 | `200` Profile |
| `PUT /api/v1/learner-profile` | 创建/更新当前画像 | `200` Profile（`profile_version` +1） |
| `POST /api/v1/learning-goals` | 创建自定义技术主题目标 | `201` Goal |
| `GET /api/v1/learning-goals` | 查询当前用户的目标列表 | `200` 目标摘要列表；每个目标仅返回最新前测摘要 |
| `GET /api/v1/learning-goals/{goal_id}` | 读取目标及当前状态 | `200` Goal |
| `DELETE /api/v1/learning-goals/{goal_id}` | 硬删除当前用户目标 | `204`；仅当没有 `queued`/`running` AgentRun 时删除。否则返回 `409 GOAL_HAS_ACTIVE_RUNS`，用户先取消任务再重试；关联业务数据、AgentRun、事件与 Outbox 一并清理。 |
| `POST /api/v1/learning-goals/{goal_id}/assessment-runs` | 请求前测生成 | `202`；成功后从 AgentRun 的 `assessment_result.assessment_id` 读取题集 |
| `GET /api/v1/assessments/{assessment_id}` | 读取题目 | `200`；交卷前仅返回题干和选项，绝不包含答案或解析 |
| `POST /api/v1/assessments/{assessment_id}/attempts` | 一次性提交完整答案并确定性评分 | `201`；保存唯一 Attempt，立即返回得分、正确答案、逐题解析和薄弱点；不调用模型。相同幂等键重试返回 `200` 原结果 |
| `GET /api/v1/assessments/{assessment_id}/attempts` | 查询题集作答历史摘要 | `200`；返回该题集当前用户的已评分 Attempt、得分和错题数量 |
| `GET /api/v1/assessment-attempts/{attempt_id}` | 读取单次作答评分详情 | `200`；仅题主可查看自己的选择、正确答案、逐题解析和分数 |

创建目标示例：

```http
POST /api/v1/learning-goals
Idempotency-Key: 5301bb75-b6a7-4d0a-9d58-3edc6b3b5999
Content-Type: application/json

{
  "topic": "Vue 3 + TypeScript",
  "title": "两周完成 Vue 3 数据看板",
  "description": "我会一点 JavaScript，希望系统学习 Composition API 和 TypeScript。",
  "desired_outcome": "能完成带路由、状态管理和列表筛选的小型前端项目。",
  "target_date": "2026-08-01",
  "weekly_minutes_override": 300
}

HTTP/1.1 201 Created

{
  "id": "79a55d76-46ed-4e7b-b4c0-1641c4a1d7d9",
  "status": "assessment_pending",
  "topic": "Vue 3 + TypeScript"
}
```

#### 前测 / 节点后测共用题目与提交合同

`diagnostic`（前测）与节点后测共用单选题公开题目和作答 API。两类题目均在首次生成时一次性保存题干、选项、隐藏答案、解析和能力标签；前测由用户选择 10–20 题（默认推荐 12），并指定 `normal` 或 `hard`；`normal` 从基础到进阶逐步提升，`hard` 在相同题序上整体提高基线。节点后测要求 `plan_node_id` 与固定 `source_card_content_id`，由用户选择 5–10 题（推荐 5–8），只覆盖该节点已经保存的内容/Demo；每次重练创建新题集。交卷前两类题目都不向浏览器返回隐藏答案或解析，交卷后仅向该 Attempt 所有者返回。

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
POST /api/v1/assessments/{assessment_id}/attempts
Idempotency-Key: 45eea8f4-1b19-4512-a702-5dd991e28122
Content-Type: application/json

{
  "answers": [
    {
      "assessment_item_id": "choice-item-uuid",
      "selected_option_key": "B"
    }
  ]
}

HTTP/1.1 201 Created

{
  "id": "attempt-uuid",
  "assessment_id": "assessment-uuid",
  "status": "graded",
  "score": {
    "total_score": 10,
    "max_score": 12,
    "score_percent": 83.33
  },
  "items": [
    {
      "assessment_item_id": "choice-item-uuid",
      "selected_option_key": "B",
      "correct_option_key": "B",
      "is_correct": true,
      "explanation": "列表使用中括号表示。"
    }
  ]
}
```

确定性评分不调用模型。交卷后的题主结果返回分数、反馈、薄弱点、正确答案和逐题解析；未交卷、其他用户和公开列表均不会返回隐藏参考答案、评分内部元数据、系统提示词或模型密钥。节点页提供后测历史列表，任一历史题集均可读取自己的作答与错题解析。节点后测结果只用于复习或提高难度建议，不会触发内容重生、改写当前路线或限制其他节点访问。

P0 不接受或使用 `model_connection_id` 作为目标级覆盖值。服务端在真正创建生成任务时解析当前用户的账户默认连接；不存在 active 默认连接时，返回明确错误而不是静默选择其他连接。

### 4.5 路线与卡片内容 API

| 方法与路径 | 用途 | 成功响应 |
| --- | --- | --- |
| `POST /api/v1/learning-goals/{goal_id}/plans` | 用户确认后，根据已评分前测请求生成路线 | `202` `{ plan_id, agent_run_id, status }`；未点击不创建模型任务 |
| `GET /api/v1/learning-plans/{plan_id}` | 读取路线和节点摘要 | `200` Plan；不返回内部 prompt/模型密钥 |
| `GET /api/v1/plan-nodes/{node_id}` | 读取节点详情 | `200` Node |
| `POST /api/v1/plan-nodes/{node_id}/content-runs` | 首次请求节点内容和本地 Demo | `202`；仅尚无成功内容时创建任务。已有成功内容返回既有内容摘要；失败记录允许重试 |
| `GET /api/v1/card-contents/{card_content_id}` | 读取已完成卡片 | `200`；`practice/debug` 卡含本地 Demo、调用顺序和中文注释；不含隐藏测试/评分依据 |
| `POST /api/v1/plan-nodes/{node_id}/completion` | 用户标记节点学习完成 | `200` Node 摘要 |
| `POST /api/v1/plan-nodes/{node_id}/post-assessment-runs` | 请求节点后测生成 | `202`；返回 `agent_run_id` 与状态 |
| `GET /api/v1/plan-nodes/{node_id}/post-assessments` | 查询节点后测历史 | `200`；按时间倒序返回题集、得分、作答状态和错题数量，题主可继续读取任一题集详情 |

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
  "local_demo": {
    "language": "python",
    "runtime_version": "3.11",
    "files": [
      {
        "path": "main.py",
        "content": "def add(a, b):\n    # 返回两个数的和\n    return a + b\n\nprint(add(2, 3))\n"
      }
    ],
    "entry_file": "main.py",
    "dependencies": [],
    "setup_steps": ["创建 Python 3.11 虚拟环境", "安装依赖（如有）"],
    "run_command": "python main.py",
    "expected_output": "5"
  },
  "call_sequence": [
    { "step": 1, "symbol": "__main__", "action": "调用 add(2, 3)" },
    { "step": 2, "symbol": "add", "action": "计算 a + b 并返回 5" },
    { "step": 3, "symbol": "print", "action": "输出返回值 5" }
  ],
  "annotated_result": [
    { "step": 1, "explanation": "程序入口发起函数调用。" },
    { "step": 2, "explanation": "add 接收两个参数并返回计算结果。" },
    { "step": 3, "explanation": "print 输出函数的返回值。" }
  ],
  "troubleshooting": [
    { "symptom": "ModuleNotFoundError", "suggestion": "确认已激活虚拟环境，并安装 dependencies 中声明的包。" }
  ]
}
```

该响应是本地运行说明，不是服务端验证结论。模型不得自行声称已经运行成功，页面也不得显示 validation、stdout、stderr、code_run_id 或类似字段。

### 4.6 Agent 状态与内部 API

| 方法与路径 | 用途 | 成功响应 |
| --- | --- | --- |
| `GET /api/v1/agent-runs/{agent_run_id}` | 查询长任务快照 | `200` 状态、进度摘要、错误类别、trace ID |
| `GET /api/v1/agent-runs/{agent_run_id}/events` | 可选 SSE 订阅/重放 | `200 text/event-stream`；支持 `Last-Event-ID` |
| `POST /internal/v1/agent-runs/{agent_run_id}/results` | Worker 回写校验后的业务结果 | 仅服务身份可用，`204` |
| `POST /internal/v1/agent-runs/{agent_run_id}/failures` | Worker 回写安全失败摘要 | 仅服务身份可用，`204` |

P0 没有代码运行 HTTP API。页面只读取 CardContent 中的 LocalDemoSpec，并将代码、依赖安装步骤和运行命令提供给用户复制；任何 `code_runs` 路由均为 P1 预留，不能在 P0 暴露。

### 4.7 API 需要先写入的契约

`packages/contracts/openapi/core.yaml` 是 Web 与 Worker 的唯一跨语言 HTTP 契约来源。P0 至少定义：

- Auth、ModelConnection、Profile、Goal、Assessment、Plan、Node、CardContent、AgentRun 的 request/response schema；
- `AssessmentItem`（仅 `single_choice`）、`AssessmentGrade`、`LocalDemoSpec`、`CallSequenceStep`、`AnnotatedResultStep` 与 `TroubleshootingStep` schema；
- `AgentRunRequested`、`PlanGenerated`、`CardContentGenerated`、`PlanNodeCompleted`、`AssessmentScored` 的事件信封 JSON Schema；
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
    participant A1 as 学习规划 Agent（Python Worker）
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
    U->>W: 保存当前画像并创建学习目标
    W->>DB: 保存唯一 Profile（版本递增）、Goal(status=assessment_pending)
    U->>W: 请求前测
    W->>DB: 创建唯一前测 Assessment(generating) + Outbox(event)
    O-->>A1: 领取 assessment.generate
    A1->>M: 生成用户指定的 10–20 题单选前测（答案与解析同次生成）
    M-->>A1: 结构化题目、隐藏答案和解析
    A1->>A1: Pydantic + 单选题/隐藏答案/解析/题量/难度校验
    A1->>W: Internal API 回写题集
    W->>DB: Assessment(status=ready)
    U->>W: 作答并提交
    W->>DB: Attempt + Answers
    W->>W: 按隐藏答案确定性评分
    W->>DB: 保存前测作答/得分/薄弱点快照（保持可生成计划状态）
    W-->>U: 展示分数、正确答案和逐题解析
    U->>W: 主动点击生成学习计划
    W->>DB: Goal(status=planning) + Outbox(plan.generate)
    O-->>A1: 领取 plan.generate
    A1->>M: 使用目标、前测交接快照和当前画像生成路线 JSON + node_brief
    A1->>A1: Schema、阶段覆盖、DAG、时长校验
    A1->>W: Internal API 回写激活路线
    W->>DB: Plan(active, profile_version/input_snapshot) + 节点
    W-->>U: 路线可见
```

### 5.2 节点内容、检索与引用流程

```mermaid
flowchart LR
    U[用户任选节点] --> W[Web：若不存在成功内容则创建 CardContent + AgentRun；否则返回既有内容]
    W --> OB[(Outbox)]
    OB --> AW[节点教学 Agent]
    AW --> NB[读取目标摘要、node_brief 与当前画像]
    AW --> F[按来源状态/标签/语言过滤]
    F --> R[RetrieverPort: FTS + pgvector 精确召回]
    R --> C[返回 source/document/chunk/locator]
    C --> MG[ModelGateway: content profile]
    MG --> LLM[托管模型 API]
    LLM --> V[Pydantic 内容 Schema + 引用校验 + teaching_memory]
    V --> P{practice/debug 节点?}
    P -->|否| API[Internal Core API]
    P -->|是| DS[校验 LocalDemoSpec 完整性]
    DS --> API
    V -->|Schema/引用失败| RETRY
    RETRY --> V
    API --> DB[(唯一成功 CardContent + LocalDemo + teaching_memory + References)]
    DB --> U
```

**不可绕过的检查：**模型只能看到获准的检索摘要；内容结果中的引用必须能映射到已有 `content_source/document/chunk`；若无法映射，标记为“模型推断”或使任务失败，不能虚构 URL/页码。`practice/debug` 节点还必须通过 LocalDemoSpec 校验：语言与版本、完整文件、入口、依赖、运行命令、预期输出、调用顺序、中文注释和排错提示齐全后，才可以连同内部 `teaching_memory` 回写给用户；不得写入任何预运行或执行输出字段。节点已有成功内容时必须返回既有内容，不能再次调用模型。

### 5.3 本地 Demo、节点后测与反馈

```mermaid
flowchart TD
    A[用户打开已保存的节点内容与本地 Demo] --> D[展示本地 Demo、运行步骤、调用顺序和中文注释]
    D --> B[用户复制到本地运行]
    B --> C[用户标记节点学习完成]
    C --> L[用户选择 5–10 题节点后测]
    L --> G[节点教学 Agent 基于固定内容、Demo 与 teaching_memory 生成新题集，答案/解析同时隐藏保存]
    G --> M[用户提交；服务端按隐藏答案确定性评分]
    M --> X[仅向本人展示分数、正确答案与逐题解析]
    X --> N{后测结果}
    N -->|>=80%| O[提示掌握]
    N -->|50-79%| P[建议复习]
    N -->|<50%| Q[提示薄弱点并可重做后测]
    O --> R[记录评分和反馈]
    P --> R
    Q --> R
    R --> S[用户可查看后测历史错题，或基于同一固定内容重新生成新题集]
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
│     │  │  ├─ learning_architect/              # 前测、前测交接摘要、用户确认后的路线生成
│     │  │  └─ node_tutor/                      # 唯一内容/Demo、teaching_memory、节点后测
│     │  ├─ acl/                                # Core API DTO ↔ Agent DTO 转换
│     │  ├─ tools/                              # profile、plan、retrieval、assessment 工具
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
│  └─ docker/{web,agent-worker}.Dockerfile
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
| Infrastructure | `infrastructure/` | Drizzle repository、Outbox publisher、Agent HTTP adapter、对象存储 adapter；P1 再增加 Sandbox adapter。 | 把基础设施 DTO 传回 UI 当领域对象。 |
| Interfaces | `interfaces/` 与 `app/api/` | Zod 请求校验、session 提取、HTTP status、presenter。 | 直接实施业务规则或访问数据库表。 |

示例：`planning/application/commands/request-plan-generation.ts` 在一个事务里创建 `learning_plans(status=generating)`、首条 `agent_runs` 的业务引用和 Outbox 事件；它不等待模型响应。`agent-worker` 完成后调用内部结果接口，由 `planning` 用例再校验、持久化节点和激活路线。

### 6.2 Python Agent Worker 的层职责

| 用户熟悉的目录 | LearnCraft 中的位置 | P0 职责 | 边界 |
| --- | --- | --- | --- |
| `core/` | `core/config.py`、`agent_execution_profiles.py`、`logging.py`、`security.py`、`dependencies.py` | Pydantic Settings、开发者内部的学习规划/节点教学 Agent Profile、密钥读取、结构化日志、内部服务鉴权、连接池。 | 不写路线、题目或用户权限规则；不提供用户或管理员参数配置接口。 |
| `schemas/` | `interfaces/http/schemas/`、`workflows/schemas/`、`application/dto/` | Pydantic 校验 HTTP、Outbox、Core API DTO、LLM 输出和图状态。 | 不能充当 SQLAlchemy ORM 或共享给浏览器。 |
| `services/` | `application/services/` | `RunService`、`ModelGateway`、重试/预算门面。 | 不直接依赖 FastAPI Request 或 SQLAlchemy session。 |
| `repositories/` | `domain/repositories/` + `infrastructure/persistence/repositories/` | AgentRun / event / checkpoint 的接口和实现。 | 不直接更新 `public.learning_plans`、`public.assessments`、`public.users`。 |
| `models/` | `infrastructure/persistence/models/` | SQLAlchemy 表映射，仅限 `agent.agent_runs`、`agent.agent_run_events`。 | 不复制 TypeScript 的核心业务模型。 |
| `workflows/` | `workflows/learning_architect/`、`workflows/node_tutor/` | 两个逻辑 Agent 的有状态编排：前测/计划与节点内容/后测；每次只读取结构化快照，不回灌无限聊天记录。 | 不把学习规则藏到 prompt，或跨 Goal/Node 读取无关上下文。 |
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

1. 已在 `apps/web/src/lib/db/schema/` 按第 3.2 节的文件归属声明当前 24 张物理表与 relation；其中 22 张属于当前 P0，`code_runs` 与 `adaptation_events` 为 P1 预留。`0003_user_model_connections` 为用户模型连接与 AgentRun 模型快照的增量迁移，`0005_model_connection_egress_audit` 为 Worker 最小出网审计表；
2. 将扩展、schema、CHECK、partial index、trigger、HNSW（暂不创建）等 Drizzle 不擅长表达的部分放在 migration raw SQL；
3. 已生成并审查 `0000_initial_p0_schema`；后续所有变更使用新的增量迁移；
4. 已在空库执行首份迁移并完成表、扩展、向量列、trigger 的 schema smoke test；下一步再加入 seed；
5. 使用测试数据库重复运行迁移，验证不会出现第二套 Alembic 迁移或 `updated_at` 漏更新。

Seed 必须包含：一名测试用户（仅测试环境）、Python 基础受控来源、至少一份文档、若干分块、对应 embedding、10–20 题前测与 5–10 题节点后测的单选题模板、隐藏答案和确定性评分 fixture、本地 Demo schema golden case、检索 golden set。真实用户密码和 Provider Key 永远不进入 seed 文件。

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

1. Profile：创建/更新唯一画像、版本递增；
2. Goal：创建自由主题目标、检查画像已经完成、支持目标列表与状态流转；
3. Assessment：创建唯一前测/节点后测容器；前测校验 10–20 题及 `normal`/`hard`，节点后测校验 5–10 题及 `plan_node_id`；仅写入单选题，服务端按隐藏答案确定性评分且不外泄；
4. Planning：以目标、前测题目/作答/分数/薄弱点和当前画像请求路线，做 DAG 验证并激活一条版本；不实现节点解锁策略；
5. Content：创建任意节点的首次内容请求、唯一成功内容、引用校验和 `teaching_memory`；实战/调试卡必须保存 LocalDemoSpec、调用顺序、注释、运行步骤和排错提示，不能保存预运行摘要或提供内容重生；
6. Practice：提供节点完成标记与本地 Demo 读取契约；P0 不创建 CodeRun 或 Runner；
7. Shared：在同一事务写 Outbox 与 IdempotencyKey，确保失败回滚时两者都不残留。

在此阶段 Worker 先接 `FakeModelGateway`，使“学习规划 Agent 前测出题 → 服务端评分与解析 → 用户确认路线 → 节点教学 Agent 唯一内容/本地 Demo → 节点后测新题集与历史错题”的 API 流可以稳定自动化测试，不消耗任何真实 Provider 额度。

### 步骤 7：实现 ModelGateway 与 OpenAI-compatible Provider Adapter

#### 流式与结构化输出约束

所有真实生成请求必须发送 `stream=true`。`SafeModelEgressClient` 以 SSE 读取 Provider 响应，限制总响应字节数，验证完成标记后在 Worker 内存中聚合文本、思考内容、工具参数和末尾用量；不得把原始分片写入数据库、日志或浏览器。对于前测/节点后测等结构化任务，Adapter 在请求载荷中同时设置 `response_format: {"type": "json_object"}`，提示词明确顶层 JSON 字段；聚合完成后先提取 JSON，再用 Pydantic 校验。首轮或修复阶段校验失败时，允许模型自行决定是否调用 Tavily MCP，并执行有限次受控修复；修复次数耗尽且主流程最终校验仍失败时，工作流强制执行 Tavily 的广搜、缩搜和资源阅读，重建结果并再次校验。Web 的 `GET /api/v1/agent-runs/{agent_run_id}/events` SSE 仅发布状态和已验证结果，不代理或展示 Provider 的原始 token 流。

P0 的**生成模型**由用户配置 OpenAI-compatible 连接（例如支持该协议的 DeepSeek、Qwen 等）；Embedding 仍固定为一个平台 Profile。先定义稳定 port，再接 OpenAI-compatible Adapter：

```text
LangGraph workflow
  → ModelGateway.generate(task_role, input, budget)
  → LLM Port / Embedding Port
  → OpenAICompatibleAdapter（LangChain integration）
  → 用户已配置的 Base URL
```

`ModelGateway` 在 P0 只使用**账户默认连接**。每个 AgentRun 在启动时固化实际连接 ID、请求模型名和开发者选择的 `AgentExecutionProfile` 版本；即使之后修改默认连接或内部调参，历史任务也不会被静默改写。删除连接后关联外键设为 `NULL`，历史记录保留模型名称与运行摘要，但不会保留 API Key。用户只选择默认模型；学习规划/节点教学 Agent 的 System Prompt、输出 Schema、最大 Token、超时、工具 allow-list、最大工具调用数、重试和思考模式仅由开发者维护。目标级、任务级模型覆盖是后续版本能力，P0 的创建目标、出题和内容生成接口不应接受或使用覆盖字段。

ModelGateway 至少维护以下任务规则；模型连接统一取账户默认连接，但预算、结构化 schema、超时、重试和工具权限由对应的内部 `AgentExecutionProfile` 控制：

| Agent / `task_role` | 内部 Profile 内容 | P0 规则 |
| --- | --- | --- |
| 学习规划 Agent / `assessment_generate` | 账户默认模型连接、评估提示词/Schema、最大输出 Token、超时、工具策略 | 前测 10–20 题；一次性输出题目、隐藏答案、解析和能力标签；校验题量、难度和至少两个选项。 |
| 学习规划 Agent / `plan_generate` | 账户默认模型连接、规划提示词/Schema、预算、重试次数和 Tavily 策略 | 仅在用户确认后使用目标、当前画像和前测交接快照；必须输出书籍章节目录式路线和 `node_brief`，并通过章节顺序、主题覆盖和 DAG 校验。首轮与修复阶段可由模型自主调用 Tavily，主流程最终校验失败时强制调用 Tavily MCP 重建。 |
| 节点教学 Agent / `card_content_generate` | 账户默认模型连接、教学提示词/Schema、预算、引用、Tavily 策略与 LocalDemoSpec | 模型可先使用自身训练知识并自行决定是否调用 Tavily；主流程最终校验失败时强制调用 Tavily MCP 的广搜、缩搜和资源阅读能力重建。最终仍只保存通过内容、引用、Demo 与 `teaching_memory`；不执行 Runner 预运行，也不支持内容重生。 |
| 节点教学 Agent / `posttest_generate` | 账户默认模型连接、后测提示词/Schema、最大输出 Token、超时、Tavily 策略 | 仅基于固定 CardContent、Demo 与 `teaching_memory` 生成 5–10 题后测；首轮与修复阶段可由模型自主调用 Tavily，主流程最终校验失败时强制阅读相关引用来源后重建；每次重练创建新题集，答案/解析同次隐藏保存。 |
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

用户自行选择生成 Provider 时，界面必须清晰展示连接名、Base URL 和模型名，但 API 响应永远不返回 API Key 密文、IV、认证标签或主密钥。保存阶段拒绝非 HTTPS、非 443、所有 IP 字面量、localhost、`.local`、回环与常见局域网地址，且产品永久不支持本地 vLLM；不自动发起校验请求。Worker 的受控出网层会在每次实际调用前复核全部 DNS 结果、拒绝私网/link-local/云 metadata、以已校验 IP 连接、拒绝重定向、限制响应体并写入审计。

### 步骤 8：使用当前 Docker Compose 基线（本地一键联调）

唯一可执行的 Compose 来源是 `infra/compose.yaml`，不要在本文复制第二份完整 YAML。它已经以本地开发为优先：Web 使用 `next dev` 和源码挂载，保存前端文件即可 Fast Refresh；生产则使用独立的 `infra/compose.production.yaml`，本地开发不启动它。

当前本地服务如下：

| 服务 | 职责 | 本机调试端口 |
| --- | --- | --- |
| `postgres` | PostgreSQL + pgvector 业务事实源 | `127.0.0.1:5432` |
| `redis` | 认证与限流；固定 DB 0 | `127.0.0.1:6379` |
| `celery-redis` | Celery Broker；固定 DB 0 | `127.0.0.1:6380` |
| `minio` | 本地 S3 兼容对象存储 | `127.0.0.1:9000` / `9001` |
| `web` | Next.js UI + BFF | `127.0.0.1:3000` |
| `agent-api` | Python 健康检查和内部调试入口 | `127.0.0.1:8000` |
| `agent-dispatcher` | PostgreSQL Outbox → Celery 可靠投递 | 不映射端口 |
| `agent-celery-worker` | 执行 AgentRun，固定 `concurrency=1` | 不映射端口 |

P0 不启动 `code-runner`，不提供在线执行 API；`code_runs` 仅为 P1 物理预留表。

初始化与启动顺序：

```powershell
Set-Location infra
Copy-Item .env.example .env
# 编辑 .env：本地密码、Embedding 配置、凭据加密主密钥和模型出网配置。

docker compose config
docker compose up --build -d
docker compose ps
docker compose logs -f web agent-api agent-dispatcher agent-celery-worker
```

日常开发可以在 Docker Desktop 的 LearnCraft Compose 应用中启动或重启服务。首次启动，或 Dockerfile、依赖、Compose、环境变量变动后，应重新构建镜像；停止服务不会删除数据库、Redis 或 MinIO 的命名卷。

第一次真实 Provider 联调前，在被 Git 忽略的 `infra/.env` 或部署 Secret Manager 中写入 `CREDENTIAL_ENCRYPTION_KEY`、模型出网配置和 Tavily Key，再通过已登录用户的模型连接 API 保存账户默认连接。`.env.example` 始终只保留空值或占位符；用户 API Key 不应成为 Compose 环境变量、Celery 消息或日志字段。

### 步骤 9：实现 Worker、检索与节点闭环

按以下顺序替换 Fake 组件；每完成一个仍保留 Fake 实现用于测试：

1. `OutboxRepository`：领取、锁定、重试、死信状态；
2. `AgentRunRepository`：保存运行、事件、重试次数、预算和 trace；
3. `RetrieverPort`：先读已审核种子内容，分别经 `VectorStore` 做 dense 召回、经词法检索端口做 FTS 召回，再由 `HybridRetriever` 用 RRF 融合，返回可引用定位；P0 注入 `PgvectorVectorStore`，未来可替换为 `MilvusVectorStore`。若 Provider 可返回 sparse 向量，再增加一次 `VectorStore` sparse 召回；
4. `LearningArchitectGraph`：前测输入规范化 → 单选题、隐藏答案/解析 Schema → Internal Core API；用户确认后，目标/画像/前测交接快照 → 书籍章节式路线 + node_brief → Pydantic schema → 章节顺序/主题覆盖/DAG/时长校验；主流程最终校验仍失败时强制执行 Tavily 广搜、缩搜和资源阅读后重建，再经 Internal Core API 持久化；
5. `NodeTutorGraph`：目标摘要 + node_brief + 当前画像 → 模型生成（可自行决定是否调用 Tavily）→ 唯一内容/teaching_memory 生成、引用校验；主流程最终校验仍失败时强制执行 Tavily“先广搜、后缩搜、资源阅读”后重建，再经 Internal Core API 持久化；节点完成后，固定内容/teaching_memory → 新节点后测题集。评分仍在 Web 侧确定性完成；
6. `NodeCompletionService`：保存用户的节点完成标记，，不限制内容生成或节点后测；后测历史查询仅返回所有者的题集、作答和错题解析；P0 不实现 RunnerClient 或 CodeRun HTTP 用例；
7. `LearningFeedbackPolicy`：用纯 TypeScript 领域规则消费节点后测评分，给出建议但不产生 `adaptation_events`、不决定解锁权限。

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
| 1 | 启动 Compose、迁移与 seed | PostgreSQL 有 `public`、`agent` schema；当前 24 张物理表、vector extension、健康检查均成功；3.4.1 的画像快照/节点后测迁移已应用。 |
| 2 | 注册并登录测试用户 | `users.password_hash` 不是明文；浏览器仅有 HttpOnly Cookie；`GET /auth/me` 成功。 |
| 3 | 写当前画像、创建两个目标并查看列表 | 一个用户只有一份画像且版本递增；两个 Goal 的 `owner_id` 正确；目标列表可展示；重复 Idempotency-Key 返回同一 Goal。 |
| 4 | 请求前测 | Assessment/AgentRun/Outbox 状态由 `generating/queued` 变为 `ready/succeeded`；用户选定 10–20 题、仅有单选题、难度符合 `normal`/`hard` 与逐步提升规则；成功题集再次请求被拒绝。 |
| 5 | 在前测生成异常、取消且没有题集时恢复 | 模型或网络异常先按有限重试、模型自主工具调用和最终 Tavily 兜底流程恢复；用户主动取消保留取消语义。无效题集不写入；没有成功题集时允许创建新的 AgentRun；已有成功题集时不允许重生；不会产生第二份成功前测。 |
| 6 | 提交前测答案并查看解析 | Attempt 只产生一条；服务端确定性评分可追踪；交卷前浏览器响应没有答案/解析，交卷后仅题主看到 `answer_key` 对应答案、逐题解析、分数与薄弱点；不创建 `plan_generate`。 |
| 7 | 用户确认生成路线并任选节点 | 点击“生成学习计划”后才创建 Learning Architect 的 `plan_generate`；路线有 6–12 个书籍章节式主题节点、合法顺序、主题覆盖、无环依赖和 `node_brief`；所有节点可直接打开；模型首轮或修复校验失败后，主流程最终校验仍失败时强制走 Tavily MCP 重建，只有通过最终校验的路线才展示。 |
| 8 | 首次请求实战/调试节点内容 | `card_contents` 和 `card_content_references` 同时存在；LocalDemoSpec 包含文件、入口、依赖、命令、预期输出、调用顺序、中文注释与排错提示，并保存 teaching_memory；同节点再次请求返回既有成功内容而不创建第二次模型调用。 |
| 9 | 标记节点完成、生成并提交多份后测 | 用户选择 5–10 道单选后测（推荐 5–8）；每次重练产生新 Assessment；80%、60%、40% 三组结果分别验证掌握、复习、薄弱点/重练提示；历史列表能打开每份题集、作答、错题和解析。 |
| 10 | 用户 B 访问用户 A 的所有资源 | 一律 `404`；日志有 trace，不泄露 A 的标题、状态或内容。 |
| 11 | 保存账户默认模型连接并做一次真实 Provider smoke | 数据库记录连接 ID、请求模型名、实际模型版本/费用；Key 不出现在响应、日志、Celery 消息或容器 inspect 输出。 |

### 步骤 12：测试与 CI 最小门槛

| 层级 | 运行位置 | P0 必测内容 |
| --- | --- | --- |
| Unit | Node/Python 进程 | 画像版本、前测唯一性/失败重试、交卷前答案隐藏/交卷后所有者解析、用户确认后才创建计划、DAG、任意节点访问、每节点唯一成功内容、固定内容后测、多份后测历史、题量/难度边界、预算策略、Zod/Pydantic schema。 |
| Repository integration | 临时 PostgreSQL + pgvector | 迁移、trigger、约束、owner filter、Outbox 锁、向量/FTS 检索。 |
| Contract | Web 与 Worker | `core.yaml` 生成物、单选题合同、确定性评分、LocalDemoSpec、internal 请求/响应、事件 JSON Schema。 |
| E2E | Compose + Fake Provider | 注册到目标列表、一次前测、评分解析、用户确认路线、任意节点唯一内容/本地 Demo、节点后测新题集与历史错题的完整闭环。 |
| Security regression | Compose/staging | 越权、会话撤销、限流、隐藏答案泄露、模型密钥/SSRF 防护与本地 Demo XSS 安全渲染。 |
| Staging smoke | 真实 Provider | 一条固定目标、固定资料、成本上限内的真实模型与 embedding 调用。 |

合并前最低 CI 流水线：`lint → typecheck → unit → migration on empty DB → repository integration → contract → E2E(fake provider) → image build/scan`。真实 Provider smoke 不放在每个 Pull Request 中，改为受保护环境的定时/发布前任务，并设单次费用上限。

---

## 8. P0 验收标准与验收清单

### 8.1 发布阻断验收标准

| 维度 | P0 必须满足 | 不满足时的处理 |
| --- | --- | --- |
| 主闭环 | 新用户可从注册到完成一个节点的唯一内容、本地 Demo 与后测历史练习；前测评分解析后由用户确认生成路线。 | 不发布；不能用截图或手工改库代替。 |
| 画像与目标 | 每账户只有一份可编辑当前画像；可创建多个目标、查看列表和详情；生成结果有画像版本与输入快照。 | 阻断目标/计划功能发布。 |
| 前测唯一性 | 前测为 10–20 题单选；每个目标只有一份成功题集，只有在生成失败或取消且未得到题集时可重新发起。 | 阻断路线生成。 |
| 路线质量 | 每条激活路线包含 6–12 个书籍章节式主题节点，章节顺序、主题覆盖和前置依赖无环；用户可访问任意节点。 | 未通过最终校验的路线不得激活；先执行 Tavily 兜底重建，只有合法路线才对用户展示。 |
| 内容可信度与唯一性 | 卡片中的来源引用可映射到受控资料；模型推断显式标记；每节点仅一份成功内容/Demo，后续请求不重调模型。 | 不展示无效/伪造引用内容或第二份成功内容。 |
| Demo 完整性 | 实战/调试卡的 LocalDemoSpec 含语言/版本、文件、入口、依赖、运行命令、预期输出、调用顺序、中文注释和排错提示。 | 不展示为本地可运行 Demo，改走修复/模板或失败态。 |
| 节点后测 | 节点完成后可基于固定内容生成 5–10 题单选后测；答案/解析首次生成时隐藏保存，交卷后仅题主可见；用户可生成新题集并查看完整历史错题。 | 保留每份题集、已作答记录和错题解析并提示重练。 |
| 用户隔离 | 越权访问所有私有资源均为 `404`；owner filter 有 repository test。 | 最高优先级安全缺陷，禁止上线。 |
| 密码与会话 | 密码仅 Argon2id 哈希；Session token 仅以哈希入库；Cookie 安全属性符合环境。 | 禁止上线。 |
| 模型密钥与出网 | `CREDENTIAL_ENCRYPTION_KEY` 仅在 Web/Worker Secret；用户 API Key 不出现在 Git、浏览器响应、日志或 Celery 消息；模型调用通过 SafeModelEgressClient。 | 立即轮换受影响用户 Key 与主密钥并阻断发布。 |
| 在线执行边界 | P0 没有 code-runner 容器、CodeRun API 或服务端代码执行入口。 | 发现入口即阻断发布；P1 需重新安全评审。 |
| 数据库 | 空库可完整迁移/seed；节点闭环所需增量迁移可重复检查；只有 Drizzle 一条迁移路径。 | 修复迁移，不允许人工补表。 |
| 可观察性 | 任意用户请求可从 `trace_id` 追到 Web、Outbox、AgentRun 和 Provider 摘要。 | 不发布涉及异步模型任务的能力。 |

### 8.2 手工验收清单

#### 账号、画像与目标

- [ ] 使用新邮箱注册成功，重复邮箱返回 `409`。
- [ ] 错误密码、已撤销 Session、过期 Session 都返回统一 `401`。
- [ ] 登录响应及浏览器存储中没有 JWT、密码、哈希或原始 Session token。
- [ ] 一个账户只存在一份当前画像；修改画像后版本递增。
- [ ] 能创建两个不同主题的目标、进入各自详情并查看目标列表；A 无法读取 B 的 Goal、Plan、Assessment、CardContent 或 AgentRun。

#### 学习闭环

- [ ] 前测由用户选择 10–20 题且只有单选题；“正常/困难”难度正确生效，题序逐步提高难度；提交前无法通过 API 拿到正确答案或解析，交卷后仅本人可看到正确答案和逐题解析。
- [ ] 前测生成失败或取消且没有题集时可重新发起；成功题集存在后再次生成被拒绝。
- [ ] 前测完成并展示评分解析后，只有点击“生成学习计划”才生成一条书籍章节式、6–12 个主题节点且带 `node_brief` 的路线；章节顺序、主题覆盖和前置依赖无环；任意节点可直接进入；最终校验失败时执行 Tavily 兜底后才展示合法路线。
- [ ] 任选节点后可看到唯一保存的目标、解释、示例、练习、提示和资料引用；实战/调试节点含完整本地 Demo、调用顺序、中文注释、命令、预期输出与排错提示；再次请求不会生成第二份内容。
- [ ] 页面不展示运行按钮、stdout/stderr、验证 ID 或“服务器已运行成功”一类结论。
- [ ] 用户标记节点完成后，可选择 5–10 题节点后测（推荐 5–8）；题集只基于固定内容/Demo/teaching_memory，服务端评分后仅本人可查看分数、正确答案、解析和薄弱点。
- [ ] 后测 80%、60%、40% 的确定性结果分别展示掌握、复习、薄弱点/重练提示；每次重练生成新题集，历史列表可查看任一题集、作答和错题解析。

#### Agent、模型与检索

- [ ] 每项异步操作立即返回可查询的 `agent_run_id`，页面有 queued/running/succeeded/failed 状态。
- [ ] Fake Provider 能完成所有 E2E；没有 Key 时本地启动不失败。
- [ ] 模型连接列表、创建、更新、删除和设为默认接口均只返回安全摘要；P0 所有生成任务使用账户默认连接。
- [ ] staging 的真实 Provider smoke 仅在用户明确触发时执行，且不超过设定 token/金额/超时预算；必须经受控 egress proxy、云网络规则与 `SafeModelEgressClient`，不得绕过 DNS/IP/重定向/审计策略。
- [ ] `agent_runs` 记录连接 ID、请求/实际模型版本、token、估算费用、重试和错误类别，不记录 API Key/完整 prompt。
- [ ] 检索结果在 seed golden set 上达到团队设定的最低 `recall@k` 与引用正确率，并保留评测结果。

#### 数据库、容器与可恢复性

- [ ] 全新 Docker volume 上 `migrate → seed → E2E` 一次成功。
- [ ] 重复相同 Idempotency-Key 的建目标、生成前测、生成路线、生成内容或生成节点后测不创建重复资源。
- [ ] `updated_at` 通过数据库 trigger 更新；应用遗漏更新字段时测试能发现。
- [ ] 本地开放的 Web、PostgreSQL、Redis、MinIO 与 Agent API 均只绑定 `127.0.0.1`；Dispatcher 与 Celery Worker 无端口映射。
- [ ] 断开模型 API、停止 Worker、重启 Web 三种故障下，用户看到安全失败态并可重试；已完成数据不丢失。
- [ ] Compose 中不存在 code-runner；Web 不存在 code-runs 路由。

### 8.3 P0 Definition of Done

P0 只有在以下条件同时满足时才算完成：

1. 第 2 节所有“暂时需要做”的需求均有实现、测试和演示证据；
2. 第 3 节当前物理 Schema、节点闭环所需增量迁移、扩展、seed、trigger 与备份/恢复演练可复现；
3. 第 4 节公开 API 均进入 OpenAPI，并通过至少一条契约测试；
4. 第 5 节三个核心流程可在 Compose 环境从 UI 跑通；
5. 第 7 节的 Fake Provider E2E 与 staging 真实 Provider smoke 都通过；
6. 第 8.1 的安全、本地 Demo 边界、模型出网与密钥门槛没有遗留 P0 级问题；
7. README 写明一次启动、迁移、seed、测试、停止和清理数据的命令。

---

## 9. 开工前的剩余实施决策

已锁定的 Embedding Profile 为 `SiliconFlow / BAAI/bge-m3 / 1024 / cosine / siliconflow-bge-m3-v1`；真实 API Key 仅写入本机 `.env` 或 Secret Manager。现在不需要再等待模型或向量维度决策；创建 `0005_content_and_pgvector` 时必须使用 `vector(1024)`。

在线 Sandbox 已明确后置 P1，因此不再阻塞 P0。P0 开工前需要落实的事项如下：

| 决策 | 建议的 P0 做法 | 影响点 |
| --- | --- | --- |
| 节点闭环与双 Agent 增量迁移 | 按 3.4.1 为 Assessment、Plan、PlanNode、CardContent 增加画像/输入快照、node_brief、teaching_memory、后测来源内容和唯一成功内容约束；复用 AgentRun Profile/摘要字段。 | 两个逻辑 Agent 的结构化交接、一次前测、唯一内容与多份后测历史的数据库约束。 |
| 首个部署域名/HTTPS | staging 和 production 使用不同 Secret 与 Cookie 配置。 | Cookie `Secure`、CORS/CSRF、反向代理、回调 URL。 |

其余选择已经在本文固定：Next.js + Python Worker、PostgreSQL + pgvector、Drizzle 单一迁移、邮箱密码 Session、Docker Compose、无本地模型、账户默认的 OpenAI-compatible 生成模型连接、固定平台 Embedding Profile。P1 的在线 Sandbox 必须在实施前重新确认语言、隔离、资源限额、成本与数据保留策略。

## 10. 实施参考

- [Next.js App Router 安装文档](https://nextjs.org/docs/app/getting-started/installation)：当前 Node.js 要求与 `create-next-app` 选项。
- [Docker Compose profiles](https://docs.docker.com/reference/compose-file/profiles/)：将 Swagger UI、迁移等开发工具置于可选 profile。
- [pgvector 官方文档](https://github.com/pgvector/pgvector)：精确近邻查询、HNSW 与 IVFFlat 的取舍和索引语法。
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)：Argon2id 密码存储建议。
