"""Outbox Dispatcher 运行时路由与领取语句的单元测试。

覆盖：
- 未配置或空对象时返回空列表（保持改造前行为，可随时回滚到 Python 运行时）；
- 只收集映射为 ts 的 run_type，并按名称排序；
- 非法 JSON 或非对象结构直接报错；
- 领取语句按 run_type 路由排除 TS 事件，且只锁 outbox 表。
"""

import os

import pytest

# dispatcher 模块在导入时会构造 Celery 应用，因此需要先提供最小配置；
# 这不影响被测逻辑，也不发起任何连接。
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/test")
os.environ.setdefault("CELERY_BROKER_URL", "redis://localhost:6379/0")

from learncraft_agent.infrastructure.queue.dispatcher import (  # noqa: E402
    CLAIM_EVENTS_SQL,
    ts_owned_run_types,
)


def test_missing_or_empty_routes_keep_python_ownership() -> None:
    """未配置路由时，Python Dispatcher 继续领取全部事件。"""
    assert ts_owned_run_types("") == []
    assert ts_owned_run_types("   ") == []
    assert ts_owned_run_types("{}") == []


def test_only_ts_mapped_run_types_are_returned_sorted() -> None:
    """只排除已交给 TypeScript 运行时的 run_type。"""
    assert ts_owned_run_types(
        '{"plan_generate":"python","assessment_generate":"ts","posttest_generate":"ts"}',
    ) == ["assessment_generate", "posttest_generate"]
    assert ts_owned_run_types('{"assessment_generate":"python"}') == []


@pytest.mark.parametrize("raw", ["not-json", "[]", '"ts"'])
def test_invalid_routes_raise_value_error(raw: str) -> None:
    """非法路由配置必须直接报错，不能静默领取全部事件。"""
    with pytest.raises(ValueError):
        ts_owned_run_types(raw)


def test_claim_sql_routes_and_locks_only_outbox() -> None:
    """领取语句必须带路由过滤，并且只锁 outbox_events。"""
    assert "JOIN agent.agent_runs" in CLAIM_EVENTS_SQL
    assert "run_type NOT IN :ts_owned_run_types" in CLAIM_EVENTS_SQL
    assert "FOR UPDATE OF outbox_event SKIP LOCKED" in CLAIM_EVENTS_SQL
    # 裸 FOR UPDATE 会连带锁住 agent.agent_runs，与 beginExecution 的行锁互相阻塞。
    assert "FOR UPDATE SKIP LOCKED" not in CLAIM_EVENTS_SQL
