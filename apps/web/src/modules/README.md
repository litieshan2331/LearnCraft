# Web 限界上下文

每个业务目录都是一个限界上下文，并遵循相同的四层结构：`interfaces → application → domain`，`infrastructure` 为 application/domain 定义的 port 提供具体实现。

```text
modules/
├─ identity/                # 账号、密码、Session
├─ profile/                 # 学习者画像与偏好
├─ planning/                # 目标、路线、节点和调整
├─ assessment/              # 前测、随堂题、作答和评分
├─ content/                 # 受控资料、检索、卡片内容
├─ practice/                # 代码运行与 Runner 适配
├─ agent-run/               # AgentRun、Outbox 投递与状态读取
└─ shared/                  # 极小共享内核，不承载业务聚合
```

跨上下文不能直接导入对方的领域实体、Drizzle record 或内部 DTO；需要通信时应使用 application facade、事件或 `packages/contracts` 中的契约。
