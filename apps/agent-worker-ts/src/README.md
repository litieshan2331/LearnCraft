# src：Agent Worker 源码

本目录存放 TypeScript 版 Agent Worker 的实现代码，按“上层依赖下层”的方向组织；
当前只实现了基础设施层的一部分。

子目录：

- `application/`：应用层用例编排（命令、服务、端口），只依赖端口不依赖具体实现。
- `acl/`：Web 内部接口防腐层。
- `schemas/`：zod 运行时契约。
- `workflows/`：各 `run_type` 的业务工作流。
- `bootstrap/`：进程配置读取（队列、Outbox、出网、内部接口）。
- `interfaces/`：外部协议适配（BullMQ 消费适配器与健康/就绪端点）。
- `infrastructure/`：与外部系统交互的实现（数据库、模型出网与凭据、Tavily 工具网关、Redis 客户端、Outbox 投递与队列装配）。
- `main/`：进程入口（dispatcher、worker）与优雅关闭。

依赖方向不可反向：基础设施层不得依赖业务流程，业务工作流也不得绕过端口直接访问数据库或出网。
