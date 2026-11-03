# Spec Delta

## MODIFIED Requirements

### Requirement: 学习助手 LangGraph 运行约束

学习助手 SHALL 使用可恢复的 LangGraph.js 图和 LangChain Agent/Tool；主 Agent 只能通过委派工具调用错题归因和苏格拉底导师子 Agent，子 Agent 不能互相调用。业务查询、Skill 和 Tavily 必须通过白名单端口，Agent 间共享事实和控制状态必须通过 LangGraph State 与工具结果传递。长期记忆服务不在本次运行路径中。

#### Scenario: 主 Agent 委派子 Agent
- **WHEN** 主 Agent 调用错题归因或苏格拉底导师委派工具
- **THEN** 系统从当前 State 注入服务端确认的任务上下文，启动对应子 Agent，并将子 Agent 的结果作为工具结果返回主 Agent
- **AND** 主 Agent 可以继续 ReAct 或生成最终回复

#### Scenario: 子 Agent 试图互相调用
- **WHEN** 任一子 Agent 请求委派工具或另一个子 Agent
- **THEN** 工具白名单拒绝该调用，子 Agent 只能调用允许的只读业务、Skill 和搜索工具

#### Scenario: 子 Agent 调用失败
- **WHEN** 子 Agent 因模型错误、工具错误、预算耗尽或输出执行失败而不能完成委派任务
- **THEN** 委派工具抛出带稳定错误码和脱敏上下文的异常给主 Agent
- **AND** 不生成空的子 Agent 结果、不伪造成功状态，主 Agent 可以决定重试、改用其他工具、降级回答或结束本轮

#### Scenario: Agent 状态交互
- **WHEN** 主 Agent、子 Agent 或工具更新诊断、导师建议、提示等级、验证目标、证据和待回答问题
- **THEN** 更新写入 LangGraph State，并由 Checkpoint 保存；不得依赖模型自行复制或解释这些控制字段

#### Scenario: 自由文本模型输出
- **WHEN** 主 Agent 或子 Agent 返回面向用户或内部分析的自然语言
- **THEN** 系统保留自由文本，不要求整段内容符合 JSON
- **AND** 工具参数、权限、状态枚举、提示等级、证据引用和持久化输入仍由程序合同校验

#### Scenario: 恢复已有 Checkpoint
- **WHEN** 学习助手运行重试或进程恢复且已有 Checkpoint
- **THEN** 使用保存的连接快照、State 和最近 20 个用户轮的完整工具链继续执行
- **AND** 不重新选择用户当前默认连接，不重复加载全部历史

#### Scenario: 学习记忆候选写入
- **WHEN** 当前运行满足服务端记忆输入策略
- **THEN** 本次变更不执行长期记忆写入；Worker 不调用旧 `learning_experience_memories` 链路，等待后续 mem0 变更
- **AND** 口头确认和模型自评不得直接改变画像或掌握度

