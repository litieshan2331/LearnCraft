"""LearnCraft Celery 应用工厂。

常量与函数：
- CELERY_TASK_NAME：AgentRun 执行任务的稳定名称。
- create_celery_app：按环境变量创建只传输 JSON 消息的 Celery 应用。
- celery_app：供 Celery CLI、Dispatcher 与任务模块共用的应用实例。
"""

from celery import Celery

from learncraft_agent.core.config import get_queue_settings

CELERY_TASK_NAME = "learncraft.agent_runs.execute"


def create_celery_app() -> Celery:
    """创建使用 Redis Broker、但不使用 Celery Result Backend 的应用实例。"""
    settings = get_queue_settings()
    broker_transport_options: dict[str, object] = {
        "visibility_timeout": settings.celery_visibility_timeout_seconds,
        "global_keyprefix": settings.celery_redis_key_prefix,
    }
    if settings.celery_broker_master_name:
        broker_transport_options["master_name"] = settings.celery_broker_master_name

    app = Celery(
        "learncraft_agent",
        include=["learncraft_agent.interfaces.celery.tasks"],
    )
    app.conf.update(
        broker_url=settings.celery_broker_url,
        broker_transport_options=broker_transport_options,
        task_default_queue=settings.celery_queue_name,
        task_routes={CELERY_TASK_NAME: {"queue": settings.celery_queue_name}},
        task_serializer="json",
        accept_content=["json"],
        result_serializer="json",
        task_ignore_result=True,
        task_acks_late=True,
        task_reject_on_worker_lost=True,
        task_publish_retry=True,
        task_publish_retry_policy={
            "max_retries": 3,
            "interval_start": 0.5,
            "interval_step": 1.0,
            "interval_max": 5.0,
        },
        task_soft_time_limit=settings.celery_task_soft_time_limit_seconds,
        task_time_limit=settings.celery_task_time_limit_seconds,
        worker_concurrency=settings.celery_worker_concurrency,
        worker_prefetch_multiplier=1,
        worker_enable_remote_control=False,
        worker_hijack_root_logger=False,
        broker_connection_retry_on_startup=True,
    )
    return app


celery_app = create_celery_app()
