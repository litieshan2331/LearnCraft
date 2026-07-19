# LearnCraft Agent Worker 容器镜像。
# 阶段：
# - dependencies：依据 pyproject.toml 与 uv.lock 缓存生产依赖。
# - runtime：复制应用源码并以非 root 用户启动 FastAPI Worker。

FROM python:3.11.15-slim-bookworm AS base

COPY --from=ghcr.io/astral-sh/uv:0.11.29 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

FROM base AS dependencies

COPY apps/agent-worker/pyproject.toml apps/agent-worker/uv.lock ./

RUN uv sync --locked --no-dev --no-install-project

FROM base AS runtime

COPY --from=dependencies /app/.venv /app/.venv
COPY apps/agent-worker ./

RUN uv sync --locked --no-dev

RUN groupadd --gid 1001 learncraft \
    && useradd --uid 1001 --gid learncraft --create-home learncraft

ENV PATH="/app/.venv/bin:${PATH}"

USER learncraft

EXPOSE 8000

CMD ["uvicorn", "learncraft_agent.main:app", "--host", "0.0.0.0", "--port", "8000"]
