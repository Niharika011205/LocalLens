"""
LLM providers behind one interface, so the pipeline never depends on a vendor.

Every provider returns JSON that conforms to a JSON Schema (structured output), and raises LLMError with `transient`
set correctly — the caller (the API's job worker) retries only transient errors.
"""

from __future__ import annotations

import json
from typing import Any, Protocol

import httpcore


class LLMError(Exception):
    def __init__(self, message: str, *, transient: bool) -> None:
        super().__init__(message)
        self.transient = transient


class LLMProvider(Protocol):
    name: str
    model: str

    def json(self, system: str, user: str, schema: dict[str, Any], max_tokens: int = 4000) -> dict[str, Any]: ...


class DisabledProvider:
    name = "none"
    model = "none"

    def json(self, system: str, user: str, schema: dict[str, Any], max_tokens: int = 4000) -> dict[str, Any]:
        raise LLMError("No language model is configured (LLM_PROVIDER=none)", transient=False)


class OllamaProvider:
    """Local models via Ollama (free, offline). Uses Ollama's JSON-schema constrained output."""

    name = "ollama"

    def __init__(self, url: str, model: str, timeout_s: float) -> None:
        self.url = url
        self.model = model
        self.timeout_s = timeout_s
        self._pool = httpcore.ConnectionPool(max_connections=2)

    def json(self, system: str, user: str, schema: dict[str, Any], max_tokens: int = 4000) -> dict[str, Any]:
        payload = {
            "model": self.model,
            "stream": False,
            "format": schema,
            "options": {"temperature": 0, "num_predict": max_tokens},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        t = {"connect": 5.0, "read": self.timeout_s, "write": 30.0, "pool": 30.0}
        try:
            response = self._pool.request(
                "POST",
                f"{self.url}/api/chat",
                headers=[(b"Content-Type", b"application/json")],
                content=json.dumps(payload).encode(),
                extensions={"timeout": t},
            )
        except (httpcore.TimeoutException, httpcore.NetworkError, httpcore.ConnectError) as exc:
            raise LLMError(f"Ollama unreachable: {type(exc).__name__}", transient=True) from exc
        if response.status >= 500 or response.status == 429:
            raise LLMError(f"Ollama returned {response.status}", transient=True)
        if response.status >= 400:
            raise LLMError(f"Ollama rejected the request ({response.status}): {response.content[:200]!r}", transient=False)
        try:
            content = json.loads(response.content)["message"]["content"]
            return json.loads(content)
        except (KeyError, ValueError) as exc:
            raise LLMError("Ollama returned output that is not valid JSON", transient=False) from exc


class AnthropicProvider:
    """
    Claude via the official Anthropic SDK, with structured outputs (output_config.format) so the response is guaranteed
    to match the schema. Forced tool use is not used: it is rejected on current models. Server-side fallbacks re-run a
    refused request on another model; a refusal that still comes back is a permanent failure (no point retrying).
    """

    name = "anthropic"

    def __init__(self, model: str, effort: str, timeout_s: float) -> None:
        import anthropic  # imported lazily so the service runs without the package when Claude is not used

        self._anthropic = anthropic
        # Retries are owned by the API's job worker (bounded backoff with jitter), so the SDK does not retry on its own.
        self._client = anthropic.Anthropic(timeout=timeout_s, max_retries=0)
        self.model = model
        self.effort = effort

    def json(self, system: str, user: str, schema: dict[str, Any], max_tokens: int = 4000) -> dict[str, Any]:
        a = self._anthropic
        try:
            response = self._client.beta.messages.create(
                model=self.model,
                max_tokens=max(max_tokens, 16000),
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                system=system,
                messages=[{"role": "user", "content": user}],
                output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": schema}},
            )
        except (a.RateLimitError, a.InternalServerError, a.APIConnectionError, a.APITimeoutError) as exc:
            raise LLMError(f"Claude temporarily unavailable: {type(exc).__name__}", transient=True) from exc
        except a.APIStatusError as exc:
            transient = exc.status_code in (408, 409, 429) or exc.status_code >= 500
            raise LLMError(f"Claude API error {exc.status_code}", transient=transient) from exc
        if response.stop_reason == "refusal":
            raise LLMError("The model declined this request", transient=False)
        if response.stop_reason == "max_tokens":
            raise LLMError("The model ran out of output tokens", transient=False)
        text = next((b.text for b in response.content if b.type == "text"), None)
        if text is None:
            raise LLMError("Claude returned no text", transient=False)
        try:
            return json.loads(text)
        except ValueError as exc:
            raise LLMError("Claude returned output that is not valid JSON", transient=False) from exc


def build_provider(settings) -> LLMProvider:
    if settings.llm_provider == "ollama":
        return OllamaProvider(settings.ollama_url, settings.ollama_model, settings.llm_timeout_s)
    if settings.llm_provider == "anthropic":
        return AnthropicProvider(settings.anthropic_model, settings.anthropic_effort, settings.llm_timeout_s)
    return DisabledProvider()
