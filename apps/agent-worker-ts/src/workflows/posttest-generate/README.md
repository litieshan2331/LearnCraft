# posttest-generate：节点后测生成（run_type=posttest_generate）

- `index.ts`：工作流主体（读取输入快照 → 内部接口取节点内容上下文与模型连接 → 解密凭据 →
  单会话 ReAct 生成与自纠 → 幂等持久化 → 返回摘要与用量）：`runPosttestGenerate`、
  `createPosttestGenerateWorkflow`、依赖端口与结果类型；转出 `schema/` 的输入合同。
- `schema/index.ts`：输入合同 `PosttestGenerationInputSchema`（extra 禁止、kind 固定 post_test、题量 5-10）。
- `prompts/index.ts`：单一 persona 的系统提示词（以节点内容为主要依据、全程允许联网核对）、
  校验反馈文案、节点内容序列化与用户提示词组装。

会话循环复用 `../../application/services/tool-aware-generator.ts` 的 `runReactAgentSession`，
题集校验与元数据映射复用 `../shared/question-set-validation.ts`。
