# Practice 限界上下文

本上下文负责用户代码运行任务、结果读取和受限 Runner 的适配。浏览器不能直接访问 Runner，且本上下文不保存或暴露隐藏测试与运行器内部信息。

运行状态规则放 `domain`，提交和查询用例放 `application`，Runner HTTP adapter 与持久化放 `infrastructure`，请求校验和响应映射放 `interfaces`。
