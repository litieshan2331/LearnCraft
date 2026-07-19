# Alembic 占位说明

P0 的数据库迁移唯一所有者是 Web 侧的 Drizzle。此目录仅用于保留未来“迁移所有权转移到 Python”时的位置，当前不得创建 revision、不得执行 `alembic revision`，也不得执行 `alembic upgrade`。

即使 Python 使用 SQLAlchemy 映射 `agent.agent_runs` 和 `agent.agent_run_events`，这些表的 DDL 仍由 Drizzle migration 创建和维护。
