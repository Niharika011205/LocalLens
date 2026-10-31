"""
LocalLens AI service. Internal only: called by the API's job worker with a shared service token, never by browsers.
It is stateless and has no database credentials, so even a fully compromised AI service cannot publish anything.

Run:  uvicorn --factory app.main:create_app --port 4200
"""

from __future__ import annotations

import hmac
import logging

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from . import assistant, pipeline
from .config import load_settings
from .fetcher import SafeFetcher
from .llm import LLMError, LLMProvider, build_provider
from .models import AnswerRequest, AnswerResponse, VerifyRequest, VerifyResponse

log = logging.getLogger("locallens.ai")


def create_app(settings=None, llm: LLMProvider | None = None, fetcher=None) -> FastAPI:
    settings = settings or load_settings()
    llm = llm or build_provider(settings)
    fetcher = fetcher or SafeFetcher(settings.user_agent, settings.fetch_timeout_s, settings.max_fetch_bytes)
    app = FastAPI(title="LocalLens AI", docs_url=None, redoc_url=None, openapi_url=None)

    def authorised(x_service_token: str = Header(default="")) -> None:
        if not hmac.compare_digest(x_service_token.encode(), settings.service_token.encode()):
            raise HTTPException(status_code=401, detail="unauthorised")

    @app.exception_handler(LLMError)
    def llm_error(_request, exc: LLMError):
        # 503 tells the caller to back off and retry; 422 tells it not to.
        code = 503 if exc.transient else 422
        log.warning("llm error (transient=%s): %s", exc.transient, exc)
        return JSONResponse(status_code=code, content={"error": {"code": "LLM_UNAVAILABLE" if exc.transient else "LLM_FAILED", "message": str(exc), "transient": exc.transient}})

    @app.get("/healthz")
    def healthz():
        return {"status": "ok", "provider": llm.name, "model": llm.model}

    # Plain `def` endpoints: FastAPI runs them in a thread pool, so slow model calls do not block the event loop.
    @app.post("/v1/verify", response_model=VerifyResponse, dependencies=[Depends(authorised)])
    def verify(req: VerifyRequest) -> VerifyResponse:
        return pipeline.verify(req, llm, fetcher, max_sources=settings.max_sources, max_claims_assessed=settings.max_claims_assessed)

    @app.post("/v1/answer", response_model=AnswerResponse, dependencies=[Depends(authorised)])
    def answer(req: AnswerRequest) -> AnswerResponse:
        return assistant.answer(req, llm)

    return app
