# AgentRun 接口层

包含 AgentRun 路径参数 Zod 校验、Session 鉴权/续期适配、安全错误 presenter、进度事件 SSE 适配器
（`agent-progress-sse.ts`：SSE 帧写入、keep-alive、断开释放订阅；订阅不可用时降级为只发心跳）。
Route Handler 提供状态读取、协作式取消与实时进度订阅；Worker 内部回写接口仍在后续业务工作流落地时实现。
