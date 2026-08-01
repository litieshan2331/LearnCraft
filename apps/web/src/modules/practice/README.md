# Practice 限界上下文

本上下文负责用户代码运行任务、结果读取和受限 Runner 的适配。代码运行是独立的 HTTP 能力，不依赖 LangGraph 工作流；浏览器不能直接访问 Runner，且本上下文不保存或暴露隐藏测试与运行器内部信息。AI Demo 生成可在后续通过轻量 AgentRun 触发，再由前端调用 CodeRun 接口运行。

运行状态规则放 `domain`，提交和查询用例放 `application`，Runner HTTP adapter 与持久化放 `infrastructure`，请求校验和响应映射放 `interfaces`。
