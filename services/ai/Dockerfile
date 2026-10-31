# syntax=docker/dockerfile:1
# LocalLens AI service: stateless FastAPI app (no database credentials). Build from the repo root:
#   docker build -f services/ai/Dockerfile -t locallens-ai .
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /srv

COPY services/ai/requirements.txt ./
RUN pip install -r requirements.txt

COPY services/ai/app app
RUN useradd --system --uid 10001 ai
USER ai

EXPOSE 4200
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:4200/healthz', timeout=2).status == 200 else 1)"
# One worker: model calls are the bottleneck, not Python. Scale by running more containers.
CMD ["uvicorn", "--factory", "app.main:create_app", "--host", "0.0.0.0", "--port", "4200", "--proxy-headers", "--no-server-header"]
