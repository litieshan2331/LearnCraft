# Profile 基础设施层

`DrizzleProfileRepository` 使用已有的 `learner_profiles`、`learning_goals`、`user_model_connections` 与 `idempotency_keys` 表实现持久化。

画像使用 PostgreSQL upsert 保存并递增版本；目标和幂等记录在同一数据库事务中创建，确保重复请求可返回同一资源。
