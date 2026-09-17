# interfaces：外部接口适配层

本目录把外部系统的调用协议适配为命令层调用，不包含业务规则。

子目录：

- `queue/`：BullMQ 消费适配器（等价于 Python 的 `interfaces/celery/`）。
